package server

import "time"

// 作业模块的「连续假期」判定：数据来自国务院办公厅每年的《部分节假日安排的通知》，
// 每年 11 月左右发布下一年的安排，发布后在这里追加数据即可（2027 年的通知发出后补上，
// 在那之前 2027 年的日期退化为只按周末合并）。日期都是公历、与家庭本地时区无关。
//
//	2025 年：国办发明电〔2024〕12 号
//	2026 年：国办发明电〔2025〕7 号
type holidayEntry struct {
	Name       string
	Start, End string
}

var holidayTable = []holidayEntry{
	{"元旦", "2025-01-01", "2025-01-01"},
	{"春节", "2025-01-28", "2025-02-04"},
	{"清明节", "2025-04-04", "2025-04-06"},
	{"劳动节", "2025-05-01", "2025-05-05"},
	{"端午节", "2025-05-31", "2025-06-02"},
	{"国庆节、中秋节", "2025-10-01", "2025-10-08"},

	{"元旦", "2026-01-01", "2026-01-03"},
	{"春节", "2026-02-15", "2026-02-23"},
	{"清明节", "2026-04-04", "2026-04-06"},
	{"劳动节", "2026-05-01", "2026-05-05"},
	{"端午节", "2026-06-19", "2026-06-21"},
	{"中秋节", "2026-09-25", "2026-09-27"},
	{"国庆节", "2026-10-01", "2026-10-07"},
}

// makeupWorkdays 是调休上班的周末：这些日子不算放假，哪怕它是周六或周日。
var makeupWorkdays = []string{
	"2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11",
	"2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
}

// Holiday 是一段连续假期，Start..End 含首尾。Start 可能是假期前一天（见 holidayWindow）。
type Holiday struct {
	Name       string `json:"name"`
	Start      string `json:"start"`
	End        string `json:"end"`
	Days       int    `json:"days"`
	BeforeFrom bool   `json:"beforeFrom"`
}

type holidayRange struct {
	start, end time.Time
	name       string
}

var (
	holidayRanges []holidayRange
	makeupSet     map[string]bool
)

// homeworkMaxRangeDays 是一条作业能覆盖的最长天数：春节 9 天 + 假前日 = 10 天，
// 这个上限只是防呆，别把范围误设成整年。
const homeworkMaxRangeDays = 21

func mustDay(v string) time.Time {
	t, err := time.Parse("2006-01-02", v)
	if err != nil {
		// 表里的日期是常量，写错了就是编译期级的错误，启动时就炸比静默算错好。
		panic("holiday table: bad date " + v)
	}
	return t
}

func init() {
	for _, entry := range holidayTable {
		holidayRanges = append(holidayRanges, holidayRange{mustDay(entry.Start), mustDay(entry.End), entry.Name})
	}
	makeupSet = make(map[string]bool, len(makeupWorkdays))
	for _, day := range makeupWorkdays {
		makeupSet[day] = true
	}
}

// restDay 判断某天是否放假：调休上班日不算，周末算，官方区间内算。
func restDay(t time.Time) bool {
	if makeupSet[t.Format("2006-01-02")] {
		return false
	}
	if weekday := t.Weekday(); weekday == time.Saturday || weekday == time.Sunday {
		return true
	}
	for _, r := range holidayRanges {
		if !t.Before(r.start) && !t.After(r.end) {
			return true
		}
	}
	return false
}

// restBlock 取包含 day 的最大连续放假块（相邻的周末与法定假自动合并）。day 不放假时 ok=false。
func restBlock(day time.Time) (start, end time.Time, name string, ok bool) {
	if !restDay(day) {
		return time.Time{}, time.Time{}, "", false
	}
	start, end = day, day
	for restDay(start.AddDate(0, 0, -1)) {
		start = start.AddDate(0, 0, -1)
	}
	for restDay(end.AddDate(0, 0, 1)) {
		end = end.AddDate(0, 0, 1)
	}
	for _, r := range holidayRanges {
		if !end.Before(r.start) && !start.After(r.end) {
			name = r.name
			break
		}
	}
	if name == "" {
		name = "周末"
	}
	return start, end, name, true
}

// HolidaySpan 是日历打标用的官方假期区间（含调休上班日），与 Holiday 的区别是它只描述
// 发布的原表、不带「假前日」这种按天推算出来的偏移。
type HolidaySpan struct {
	Name  string `json:"name"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// holidaySpans 是 /state 下发给日历的整张表：家里没网也能标出「休」的那几天。
func holidaySpans() []HolidaySpan {
	out := make([]HolidaySpan, 0, len(holidayTable))
	for _, entry := range holidayTable {
		out = append(out, HolidaySpan{Name: entry.Name, Start: entry.Start, End: entry.End})
	}
	return out
}

// holidayWindow 返回 day 对应的「假期作业默认范围」：day 在假期里就从假期第一天算起；
// day 是假期前最后一个工作日（如周五、或调休上班的周六）就从 day 算起，直到假期结束。
// 离假期不沾边时 ok=false。
func holidayWindow(day time.Time) (Holiday, bool) {
	start, end, name, ok := restBlock(day)
	beforeFrom := false
	if !ok {
		// 假前日：这一天是工作日、第二天开始放假，那它也算假期作业的一部分。
		start, end, name, ok = restBlock(day.AddDate(0, 0, 1))
		if !ok {
			return Holiday{}, false
		}
		start, beforeFrom = day, true
	}
	days := int(end.Sub(start).Hours()/24) + 1
	if days > homeworkMaxRangeDays {
		days = homeworkMaxRangeDays
		end = start.AddDate(0, 0, homeworkMaxRangeDays-1)
	}
	return Holiday{
		Name:       name,
		Start:      start.Format("2006-01-02"),
		End:        end.Format("2006-01-02"),
		Days:       days,
		BeforeFrom: beforeFrom,
	}, true
}
