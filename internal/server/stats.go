package server

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"time"
)

// 本文件是 GET /stats 的全部实现：区间解析、按模板推导应完成数、按窗口读取
// 提交与台账。它只读，不改任何表。

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	cid := x.SelectedChildID
	loc, err := s.familyLocation(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	today := s.now().In(loc)
	from, to, ok := statsWindow(r, today, loc)
	if !ok {
		problem(w, 400, "invalid_request", "invalid stats range")
		return
	}
	startDate, endDate := from.Format("2006-01-02"), to.Format("2006-01-02")
	// 窗口下推到 SQL：台账与提交会一直变长，把整份历史读进内存再过滤只是把慢藏在后面。
	// reviewed_at/created_at 都是 UTC 的 RFC3339Nano；边界用不带 Z 的秒级字符串做字典序
	// 比较——行落在边界那一秒内时字符串更长、排在边界之后，所以「起点含、终点不含」精确。
	windowStart := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc).UTC().Format("2006-01-02T15:04:05")
	windowEnd := time.Date(to.Year(), to.Month(), to.Day()+1, 0, 0, 0, 0, loc).UTC().Format("2006-01-02T15:04:05")
	// Instance rows only exist for the days that were read, so a historical
	// window would count zero scheduled tasks; derive the number from the
	// templates instead. The query holds the pool's single connection, so it
	// must finish before the two queries below start.
	scheduled, err := s.scheduledTaskCount(r.Context(), x.FamilyID, cid, from, to, loc)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	type dailyStat struct {
		Date      string `json:"date"`
		Label     string `json:"label"`
		Completed int    `json:"completed"`
	}
	type categoryStat struct {
		Name    string `json:"name"`
		Count   int    `json:"count"`
		Percent int    `json:"percent"`
	}
	days := 0
	for offset := 0; ; offset++ {
		if time.Date(from.Year(), from.Month(), from.Day()+offset, 0, 0, 0, 0, loc).After(to) {
			break
		}
		days++
	}
	daily := make([]dailyStat, 0, days)
	dailyIndex := map[string]int{}
	weekdayLabels := [...]string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}
	for offset := 0; offset < days; offset++ {
		// Calendar arithmetic on the date fields, not AddDate: a DST transition
		// does not always leave the same wall-clock time inside the same day.
		day := time.Date(from.Year(), from.Month(), from.Day()+offset, 0, 0, 0, 0, loc)
		label := weekdayLabels[day.Weekday()]
		if days > 14 {
			// A weekday name repeats in a long window; a short date does not.
			label = fmt.Sprintf("%d/%d", day.Month(), day.Day())
		}
		date := day.Format("2006-01-02")
		daily = append(daily, dailyStat{Date: date, Label: label})
		dailyIndex[date] = len(daily) - 1
	}
	categoryCounts := map[string]int{}
	completed := 0
	rows, err := s.db.Query(`SELECT i.category,s.reviewed_at FROM task_submissions s JOIN task_instances i ON i.id=s.task_instance_id WHERE s.family_id=? AND s.child_id=? AND s.approved=1 AND s.reviewed_at IS NOT NULL AND s.reviewed_at>=? AND s.reviewed_at<?`, x.FamilyID, cid, windowStart, windowEnd)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for rows.Next() {
		var category, reviewedAt string
		if err = rows.Scan(&category, &reviewedAt); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		reviewed, parseErr := time.Parse(time.RFC3339Nano, reviewedAt)
		if parseErr != nil {
			rows.Close()
			s.internalError(w, r, parseErr)
			return
		}
		date := reviewed.In(loc).Format("2006-01-02")
		if index, ok := dailyIndex[date]; ok {
			daily[index].Completed++
			categoryCounts[category]++
			completed++
		}
	}
	if err = rows.Close(); err != nil {
		s.internalError(w, r, err)
		return
	}

	earned, spent := 0, 0
	rows, err = s.db.Query(`SELECT amount,created_at FROM point_ledger WHERE family_id=? AND child_id=? AND created_at>=? AND created_at<?`, x.FamilyID, cid, windowStart, windowEnd)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for rows.Next() {
		var amount int
		var createdAt string
		if err = rows.Scan(&amount, &createdAt); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		created, parseErr := time.Parse(time.RFC3339Nano, createdAt)
		if parseErr != nil {
			rows.Close()
			s.internalError(w, r, parseErr)
			return
		}
		date := created.In(loc).Format("2006-01-02")
		if date < startDate || date > endDate {
			continue
		}
		if amount > 0 {
			earned += amount
		} else {
			spent -= amount
		}
	}
	if err = rows.Close(); err != nil {
		s.internalError(w, r, err)
		return
	}

	// The list is derived from the confirmations in the window: a family that
	// renamed a category, or whose children only ever do one kind of task, must
	// see its own names rather than a fixed trio. Order is by count descending,
	// ties by name, so the payload is deterministic.
	names := make([]string, 0, len(categoryCounts))
	for name := range categoryCounts {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if categoryCounts[names[i]] != categoryCounts[names[j]] {
			return categoryCounts[names[i]] > categoryCounts[names[j]]
		}
		return names[i] < names[j]
	})
	categories := make([]categoryStat, 0, len(names))
	for _, name := range names {
		count := categoryCounts[name]
		percent := 0
		if completed > 0 {
			percent = count * 100 / completed
		}
		categories = append(categories, categoryStat{Name: name, Count: count, Percent: percent})
	}
	writeJSON(w, 200, map[string]any{"from": startDate, "to": endDate, "totalTasks": scheduled, "completedTasks": completed, "earnedPoints": earned, "spentPoints": spent, "daily": daily, "categories": categories})
}

// statsMaxRangeDays bounds one stats window. The daily series carries one
// bucket per day, so the ceiling keeps the chart (and the response) readable
// rather than guarding performance.
const statsMaxRangeDays = 92

// statsWindow resolves ?from/?to (family-local 2006-01-02 dates) into the
// inclusive window to report on. Neither parameter means the trailing seven
// days; a single parameter, an unparseable date, from > to or a window wider
// than statsMaxRangeDays are all rejected. A future date is not an error: it
// simply has no data.
func statsWindow(r *http.Request, today time.Time, loc *time.Location) (time.Time, time.Time, bool) {
	end := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)
	fromValue, toValue := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if fromValue == "" && toValue == "" {
		return end.AddDate(0, 0, -6), end, true
	}
	if fromValue == "" || toValue == "" {
		return time.Time{}, time.Time{}, false
	}
	from, fromErr := time.ParseInLocation("2006-01-02", fromValue, loc)
	to, toErr := time.ParseInLocation("2006-01-02", toValue, loc)
	if fromErr != nil || toErr != nil || from.After(to) {
		return time.Time{}, time.Time{}, false
	}
	if to.After(from.AddDate(0, 0, statsMaxRangeDays-1)) {
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

// scheduledTaskCount is how many tasks the child was supposed to complete in
// the window, derived from the templates: a daily template counts once per day
// from its creation day (clamped to the window), a weekly one only on its
// weekday, and a once template on the day it was created (its due_date).
// task_instances cannot answer this because ensureInstances only materializes
// the day or week that was read, so a historical window would always report
// zero. Inactive templates are excluded: deleting one cascades to its
// submissions, so counting it would report a gap nobody can close.
func (s *Server) scheduledTaskCount(ctx context.Context, family, child string, from, to time.Time, loc *time.Location) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT repeat_rule,repeat_weekday,repeat_weekdays,created_at FROM task_templates WHERE family_id=? AND child_id=? AND active=1`, family, child)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	total := 0
	for rows.Next() {
		var rule, created, set string
		var weekday int
		if err = rows.Scan(&rule, &weekday, &set, &created); err != nil {
			return 0, err
		}
		at, parseErr := time.Parse(time.RFC3339Nano, created)
		if parseErr != nil {
			return 0, parseErr
		}
		local := at.In(loc)
		createdDay := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
		if rule == "once" {
			if !createdDay.Before(from) && !createdDay.After(to) {
				total++
			}
			continue
		}
		first := createdDay
		if first.Before(from) {
			first = from
		}
		// 多选星期要在集合里查，老数据（空串）就是 repeat_weekday 那一天；
		// 不这么算的话 /stats 的分母会比实际排期少算几天。
		days := repeatWeekdayList(set, weekday)
		for offset := 0; ; offset++ {
			day := time.Date(first.Year(), first.Month(), first.Day()+offset, 0, 0, 0, 0, loc)
			if day.After(to) {
				break
			}
			if rule == "weekly" && !slices.Contains(days, int(day.Weekday())) {
				continue
			}
			total++
		}
	}
	return total, rows.Err()
}
