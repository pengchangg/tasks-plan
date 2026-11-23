package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// 本文件是 /state 的读取端：把模板排成当期实例、算连续天数，再把整份家庭快照
// 拼成一个 State。写操作仍在 server.go，这里只读不写（ensureInstances 例外，
// 它按需物化今天的实例，本来就是一次读带来的副作用）。

func (s *Server) ensureInstances(ctx context.Context, family string) error {
	loc, err := s.familyLocation(ctx, family)
	if err != nil {
		return err
	}
	now := s.now().In(loc)
	date := now.Format("2006-01-02")
	monday, err := s.weekStart(ctx, family)
	if err != nil {
		return err
	}
	week := monday.Format("2006-01-02")
	rows, err := s.db.QueryContext(ctx, `SELECT id,child_id,title,description,category,points,repeat_rule,repeat_weekday,repeat_weekdays,created_at FROM task_templates WHERE family_id=? AND active=1`, family)
	if err != nil {
		return err
	}
	type template struct {
		tid, cid, title, desc, cat, rule, created string
		points, weekday                           int
		weekdays                                  string
	}
	var templates []template
	for rows.Next() {
		var v template
		if err = rows.Scan(&v.tid, &v.cid, &v.title, &v.desc, &v.cat, &v.points, &v.rule, &v.weekday, &v.weekdays, &v.created); err != nil {
			rows.Close()
			return err
		}
		templates = append(templates, v)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	// 一个实例要占的期次：一次任务只有创建那天一个，每日任务只有今天一个，
	// 每周任务按选中的星期各一个。
	type bucket struct {
		key     string
		due     string
		weekday int
	}
	for _, v := range templates {
		buckets := []bucket{{key: date, due: date, weekday: v.weekday}}
		if v.rule == "once" {
			created, parseErr := time.Parse(time.RFC3339Nano, v.created)
			if parseErr != nil {
				return fmt.Errorf("parse task template creation time: %w", parseErr)
			}
			buckets = []bucket{{key: "once", due: created.In(loc).Format("2006-01-02"), weekday: v.weekday}}
		}
		if v.rule == "weekly" {
			// 多选星期把那天编进 period_key，同一周的周一和周三才是两回事；
			// 只选一天（repeat_weekdays 是空串）沿用整周一个 key 的老格式。
			days := repeatWeekdayList(v.weekdays, v.weekday)
			buckets = nil
			for _, day := range days {
				key := week
				if len(days) > 1 {
					key = week + ":" + strconv.Itoa(day)
				}
				buckets = append(buckets, bucket{key: key, due: monday.AddDate(0, 0, (day+6)%7).Format("2006-01-02"), weekday: day})
			}
		}
		for _, b := range buckets {
			_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_instances(id,family_id,template_id,child_id,period_key,title,description,category,points,repeat_rule,repeat_weekday,repeat_weekdays,due_date,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("task"), family, v.tid, v.cid, b.key, v.title, v.desc, v.cat, v.points, v.rule, b.weekday, v.weekdays, b.due, "todo", nowText(s.now()))
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// weekStart 是本周一零点（家庭时区）——排期与改星期时算 period_key 共用一个口径。
func (s *Server) weekStart(ctx context.Context, family string) (time.Time, error) {
	loc, err := s.familyLocation(ctx, family)
	if err != nil {
		return time.Time{}, err
	}
	now := s.now().In(loc)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -(int(now.Weekday())+6)%7), nil
}

// streakLookbackDays 限制 /state 读账本的深度：连续天数只从今天往回逐日走，
// 更早的记录不会改变任何一天的结果，却要每天整表解析一遍。超过这个窗口的连续
// 天数按窗口内计（400 天足够覆盖任何真实使用）。
const streakLookbackDays = 400

func (s *Server) streaks(ctx context.Context, family string, loc *time.Location) (map[string]int, error) {
	since := nowText(s.now().AddDate(0, 0, -streakLookbackDays))
	rows, err := s.db.QueryContext(ctx, `SELECT child_id,created_at FROM point_ledger WHERE family_id=? AND entry_type='earned' AND created_at>=? ORDER BY created_at DESC`, family, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	datesByChild := map[string]map[string]struct{}{}
	for rows.Next() {
		var childID, createdAt string
		if err = rows.Scan(&childID, &createdAt); err != nil {
			return nil, err
		}
		created, parseErr := time.Parse(time.RFC3339Nano, createdAt)
		if parseErr != nil {
			return nil, fmt.Errorf("parse ledger creation time: %w", parseErr)
		}
		if datesByChild[childID] == nil {
			datesByChild[childID] = map[string]struct{}{}
		}
		datesByChild[childID][created.In(loc).Format("2006-01-02")] = struct{}{}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	result := map[string]int{}
	today := s.now().In(loc)
	for childID, dates := range datesByChild {
		cursor := today
		if _, ok := dates[cursor.Format("2006-01-02")]; !ok {
			cursor = cursor.AddDate(0, 0, -1)
		}
		for {
			if _, ok := dates[cursor.Format("2006-01-02")]; !ok {
				break
			}
			result[childID]++
			cursor = cursor.AddDate(0, 0, -1)
		}
	}
	return result, nil
}

func (s *Server) state(ctx context.Context, x session) (State, error) {
	var out State
	out.Role = x.ActorType
	out.ActiveChildID = x.SelectedChildID
	if err := s.ensureInstances(ctx, x.FamilyID); err != nil {
		return out, err
	}
	loc, err := s.familyLocation(ctx, x.FamilyID)
	if err != nil {
		return out, err
	}
	out.Timezone = loc.String()
	out.Holidays = holidaySpans()
	out.MakeupWorkdays = append([]string{}, makeupWorkdays...)
	if out.GameCosts.PlayCost, out.GameCosts.HintCost, err = s.gameCostValues(ctx, x.FamilyID); err != nil {
		return out, err
	}
	streaks, err := s.streaks(ctx, x.FamilyID, loc)
	if err != nil {
		return out, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,avatar,color,experience,points_balance FROM children WHERE family_id=? ORDER BY created_at`, x.FamilyID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var c Child
		// children.experience 是 REAL 列：扫描进 int 时驱动会把值格式化再解析一次，
		// 一个非整数值就让 /state 整体 500。按 REAL 扫、显式取整，坏数据只影响这一行
		// 的等级显示。
		var totalExperience float64
		if err = rows.Scan(&c.ID, &c.Name, &c.Avatar, &c.Color, &totalExperience, &c.PointsBalance); err != nil {
			rows.Close()
			return out, err
		}
		total := int(totalExperience)
		c.Level = 1 + total/100
		c.Experience = float64(total % 100)
		c.StreakDays = streaks[c.ID]
		out.Children = append(out.Children, c)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,child_id,title,description,category,points,repeat_rule,repeat_weekday,repeat_weekdays,due_date,status,created_at FROM task_instances WHERE family_id=? AND template_id IS NOT NULL AND (?='parent' OR child_id=?) ORDER BY created_at DESC`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Task
		var weekdays string
		if err = rows.Scan(&v.ID, &v.ChildID, &v.Title, &v.Description, &v.Category, &v.Points, &v.RepeatRule, &v.RepeatWeekday, &weekdays, &v.DueDate, &v.Status, &v.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
		v.RepeatWeekdays = parseRepeatWeekdays(weekdays)
		out.Tasks = append(out.Tasks, v)
	}
	rows.Close()
	attachmentBySubmission := map[string][]Attachment{}
	rows, err = s.db.QueryContext(ctx, `SELECT a.submission_id,a.id,a.original_name,a.media_type FROM attachments a JOIN task_submissions s ON s.id=a.submission_id WHERE a.family_id=? AND (?='parent' OR s.child_id=?) ORDER BY a.created_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var sid string
		var a Attachment
		if err = rows.Scan(&sid, &a.ID, &a.Name, &a.Type); err != nil {
			rows.Close()
			return out, err
		}
		a.URL = "/api/v1/media/" + a.ID
		attachmentBySubmission[sid] = append(attachmentBySubmission[sid], a)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,task_instance_id,child_id,note,submitted_at,reviewed_at,review_note FROM task_submissions WHERE family_id=? AND (?='parent' OR child_id=?) ORDER BY submitted_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Submission
		var reviewed, note sql.NullString
		if err = rows.Scan(&v.ID, &v.TaskID, &v.ChildID, &v.Note, &v.SubmittedAt, &reviewed, &note); err != nil {
			rows.Close()
			return out, err
		}
		if reviewed.Valid {
			v.ReviewedAt = &reviewed.String
		}
		if note.Valid {
			v.ReviewNote = &note.String
		}
		v.Attachments = attachmentBySubmission[v.ID]
		if v.Attachments == nil {
			v.Attachments = []Attachment{}
		}
		out.Submissions = append(out.Submissions, v)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,title,description,points_cost,icon,color,is_active FROM wishes WHERE family_id=? AND deleted_at IS NULL ORDER BY created_at DESC`, x.FamilyID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Wish
		var active int
		if err = rows.Scan(&v.ID, &v.Title, &v.Description, &v.PointsCost, &v.Icon, &v.Color, &active); err != nil {
			rows.Close()
			return out, err
		}
		v.IsActive = active == 1
		out.Wishes = append(out.Wishes, v)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,child_id,amount,entry_type,reference_type,reference_id,description,created_at FROM point_ledger WHERE family_id=? AND (?='parent' OR child_id=?) ORDER BY created_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Ledger
		if err = rows.Scan(&v.ID, &v.ChildID, &v.Amount, &v.Type, &v.ReferenceType, &v.ReferenceID, &v.Description, &v.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Ledger = append(out.Ledger, v)
	}
	rows.Close()
	attachmentByRedemption := map[string][]Attachment{}
	rows, err = s.db.QueryContext(ctx, `SELECT a.redemption_id,a.id,a.original_name,a.media_type FROM attachments a JOIN redemptions r ON r.id=a.redemption_id WHERE a.family_id=? AND (?='parent' OR r.child_id=?) ORDER BY a.created_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var rid string
		var a Attachment
		if err = rows.Scan(&rid, &a.ID, &a.Name, &a.Type); err != nil {
			rows.Close()
			return out, err
		}
		a.URL = "/api/v1/media/" + a.ID
		attachmentByRedemption[rid] = append(attachmentByRedemption[rid], a)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT r.id,COALESCE(r.wish_id,''),r.wish_title,COALESCE(w.icon,'🎁'),COALESCE(w.color,'#ffcf70'),r.child_id,r.points_cost,r.completed_at,r.completed_note,r.created_at FROM redemptions r LEFT JOIN wishes w ON w.id=r.wish_id WHERE r.family_id=? AND (?='parent' OR r.child_id=?) ORDER BY r.created_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Redemption
		var completed, note sql.NullString
		if err = rows.Scan(&v.ID, &v.WishID, &v.WishTitle, &v.WishIcon, &v.WishColor, &v.ChildID, &v.PointsCost, &completed, &note, &v.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
		if completed.Valid {
			v.CompletedAt = &completed.String
		}
		if note.Valid {
			v.CompletedNote = note.String
		}
		v.Attachments = attachmentByRedemption[v.ID]
		if v.Attachments == nil {
			v.Attachments = []Attachment{}
		}
		out.Redemptions = append(out.Redemptions, v)
	}
	rows.Close()
	if out.Children == nil {
		out.Children = []Child{}
	}
	if out.Tasks == nil {
		out.Tasks = []Task{}
	}
	if out.Submissions == nil {
		out.Submissions = []Submission{}
	}
	if out.Wishes == nil {
		out.Wishes = []Wish{}
	}
	if out.Ledger == nil {
		out.Ledger = []Ledger{}
	}
	if out.Redemptions == nil {
		out.Redemptions = []Redemption{}
	}
	return out, nil
}
func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	out, err := s.state(r.Context(), sess(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, out)
}
