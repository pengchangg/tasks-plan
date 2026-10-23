package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// pngMagic is enough of a PNG for inspectUpload, which sniffs the first bytes.
var pngMagic = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

func testServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(Config{DBPath: filepath.Join(dir, "test.db"), MediaDir: filepath.Join(dir, "media")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err = s.CreateFamily(context.Background(), FamilyInput{Code: "DEMO", Name: "Demo", Username: "parent", Password: "2468"}); err != nil {
		t.Fatal(err)
	}
	if err = s.SeedDemo(context.Background(), "DEMO"); err != nil {
		t.Fatal(err)
	}
	return s
}
func doJSON(t *testing.T, h http.Handler, method, path string, body any, cookie *http.Cookie, key string) *httptest.ResponseRecorder {
	t.Helper()
	var b bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&b).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, &b)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func parentCookie(t *testing.T, h http.Handler) *http.Cookie {
	t.Helper()
	w := doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"password": "2468"}, nil, "")
	if w.Code != 200 {
		t.Fatalf("parent unlock: %d %s", w.Code, w.Body.String())
	}
	return w.Result().Cookies()[0]
}
func childCookie(t *testing.T, h http.Handler, childID string) *http.Cookie {
	t.Helper()
	w := doJSON(t, h, "POST", "/api/v1/auth/child", nil, nil, "")
	if w.Code != 200 {
		t.Fatalf("child end: %d %s", w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if childID == "" {
		return cookie
	}
	if w = doJSON(t, h, "PATCH", "/api/v1/session/child", map[string]string{"childId": childID}, cookie, ""); w.Code != 204 {
		t.Fatalf("select child: %d %s", w.Code, w.Body.String())
	}
	return cookie
}
func sessionFor(t *testing.T, s *Server, family, actorType, actor, child string) *http.Cookie {
	t.Helper()
	raw := "test-" + actorType + "-" + actor
	if _, err := s.db.Exec(`INSERT INTO sessions(id,token_hash,family_id,actor_type,actor_id,selected_child_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)`, id("ses"), tokenHash(raw), family, actorType, actor, nullString(child), nowText(s.now().Add(time.Hour)), nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: cookieName, Value: raw}
}

// otherFamily inserts a second families row directly. CreateFamily refuses one
// — this deployment only ever serves the oldest row — but tests need a foreign
// family (isolation) or one with another timezone, and isolation has to hold
// for any families row, however it got there. The stamp is deliberately later
// than the served family's so the oldest row stays the one resolvedFamily picks.
func otherFamily(t *testing.T, s *Server, code, timezone string) string {
	t.Helper()
	fid := id("fam")
	if _, err := s.db.Exec(`INSERT INTO families(id,code,name,timezone,created_at) VALUES(?,?,?,?,?)`, fid, code, code, timezone, nowText(s.now().Add(24*time.Hour))); err != nil {
		t.Fatal(err)
	}
	return fid
}
func getStateTest(t *testing.T, h http.Handler, c *http.Cookie) State {
	t.Helper()
	w := doJSON(t, h, "GET", "/api/v1/state", nil, c, "")
	if w.Code != 200 {
		t.Fatalf("state: %d %s", w.Code, w.Body.String())
	}
	var state State
	if err := json.NewDecoder(w.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func multipartRequest(t *testing.T, method, path string, cookie *http.Cookie, key string, fields map[string]string, files map[string][]byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		part, err := writer.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Idempotency-Key", key)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	return r
}

func TestMigrationsAreAppliedExactlyOnceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{DBPath: filepath.Join(dir, "restart.db"), MediaDir: filepath.Join(dir, "media")}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// A database an earlier boot already created: 001_init.sql is re-executed
	// on every Open, so re-running it must leave an existing store alone.
	earlier, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := migrationFS.ReadFile("migrations/001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = earlier.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	if _, err = earlier.Exec(`INSERT INTO families(id,code,name,timezone,created_at) VALUES('family-legacy','LEGACY','Legacy','Asia/Shanghai','2025-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err = earlier.Exec(`INSERT INTO children(id,family_id,name,avatar,color,level,experience,created_at) VALUES('child-legacy','family-legacy','Legacy child','x','#000',4,372,'2025-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err = earlier.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	// The schema of record is one file now, so assert the columns the merged
	// statements must carry instead of replaying the old ALTER chain.
	for _, probe := range []struct {
		table, column string
		want          int
	}{
		{"children", "pin_hash", 0},
		{"task_templates", "repeat_weekday", 1},
		{"task_instances", "repeat_weekday", 1},
		{"redemptions", "completed_at", 1},
		{"redemptions", "completed_note", 1},
		{"attachments", "redemption_id", 1},
	} {
		var found int
		if err = s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('`+probe.table+`') WHERE name=?`, probe.column).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != probe.want {
			t.Fatalf("column %s.%s present=%d, want %d", probe.table, probe.column, found, probe.want)
		}
	}
	var before int
	if err = s.db.QueryRow(`SELECT experience FROM children WHERE id='child-legacy'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != 372 {
		t.Fatalf("experience=%d, want 372", before)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var after, migrations int
	if err = s.db.QueryRow(`SELECT experience FROM children WHERE id='child-legacy'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	want := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			want++
		}
	}
	if after != before || migrations != want {
		t.Fatalf("restart experience=%d (before %d), migrations=%d (want %d)", after, before, migrations, want)
	}
}

func TestRejectsCrossOriginMutation(t *testing.T) {
	s := testServer(t)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/parent", bytes.NewBufferString(`{"password":"2468"}`))
	r.Host = "growjoy.example"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin login status=%d, want 403", w.Code)
	}
}

func TestFamilyTimezoneWeeklyScheduleAndConsecutiveStreak(t *testing.T) {
	s := testServer(t)
	s.now = func() time.Time { return time.Date(2025, 1, 6, 0, 30, 0, 0, time.UTC) }
	// This test needs a family whose timezone is not the served DEMO one, so it
	// is inserted directly (CreateFamily refuses a second family).
	family := otherFamily(t, s, "PACIFIC", "America/Los_Angeles")
	if err := s.SeedDemo(context.Background(), "PACIFIC"); err != nil {
		t.Fatal(err)
	}
	var child string
	if err := s.db.QueryRow(`SELECT id FROM children WHERE family_id=? ORDER BY created_at LIMIT 1`, family).Scan(&child); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO task_templates(id,family_id,child_id,title,description,category,points,repeat_rule,repeat_weekday,created_at,updated_at) VALUES('weekly-test',?,?,?,?,?,10,'weekly',3,?,?)`, family, child, "Weekly", "", "学习成长", nowText(s.now()), nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	if err := s.ensureInstances(context.Background(), family); err != nil {
		t.Fatal(err)
	}
	var due string
	if err := s.db.QueryRow(`SELECT due_date FROM task_instances WHERE template_id='weekly-test'`).Scan(&due); err != nil {
		t.Fatal(err)
	}
	if due != "2025-01-01" {
		t.Fatalf("weekly due date=%s, want 2025-01-01", due)
	}
	var seededDue string
	if err := s.db.QueryRow(`SELECT due_date FROM task_instances WHERE family_id=? AND repeat_rule='daily' ORDER BY due_date DESC LIMIT 1`, family).Scan(&seededDue); err != nil {
		t.Fatal(err)
	}
	if seededDue != "2025-01-05" {
		t.Fatalf("Pacific local date=%s, want 2025-01-05", seededDue)
	}

	if _, err := s.db.Exec(`DELETE FROM point_ledger WHERE family_id=? AND child_id=?`, family, child); err != nil {
		t.Fatal(err)
	}
	for index, created := range []string{"2025-01-06T07:00:00Z", "2025-01-04T20:00:00Z", "2025-01-02T20:00:00Z"} {
		if _, err := s.db.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,5,'earned','test',?,'test',?)`, id("ledger"), family, child, index, created); err != nil {
			t.Fatal(err)
		}
	}
	loc, err := s.familyLocation(context.Background(), family)
	if err != nil {
		t.Fatal(err)
	}
	streaks, err := s.streaks(context.Background(), family, loc)
	if err != nil {
		t.Fatal(err)
	}
	if streaks[child] != 2 {
		t.Fatalf("streak=%d, want 2", streaks[child])
	}
	payload, err := s.state(context.Background(), session{FamilyID: family, ActorType: "parent", SelectedChildID: child})
	if err != nil {
		t.Fatal(err)
	}
	if payload.Timezone != "America/Los_Angeles" {
		t.Fatalf("state timezone=%q, want America/Los_Angeles", payload.Timezone)
	}
}

func TestUploadContentSniffingAndConcurrentSubmission(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	state := getStateTest(t, h, parent)
	var task Task
	for _, candidate := range state.Tasks {
		if candidate.Status == "todo" {
			task = candidate
			break
		}
	}
	if task.ID == "" {
		t.Fatal("missing todo task")
	}
	child := childCookie(t, h, task.ChildID)

	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", child, "bad-upload", nil, map[string][]byte{"fake.jpg": []byte("plain text")}))
	if bad.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("fake image status=%d, want 415", bad.Code)
	}

	// Only a child submits, and only its own task. Both guards answer before the
	// request can claim its idempotency key, so the task stays submittable for
	// the concurrent pair below.
	parentSubmit := httptest.NewRecorder()
	h.ServeHTTP(parentSubmit, multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", parent, "parent-submit", nil, nil))
	if parentSubmit.Code != http.StatusForbidden || !strings.Contains(parentSubmit.Body.String(), "forbidden") {
		t.Fatalf("parent submission: %d %s", parentSubmit.Code, parentSubmit.Body.String())
	}
	if w := doJSON(t, h, "POST", "/api/v1/children/", map[string]string{"name": "弟弟", "avatar": "★", "color": "#8f7bd2"}, parent, ""); w.Code != 200 {
		t.Fatalf("create sibling: %d %s", w.Code, w.Body.String())
	}
	siblings := getStateTest(t, h, parent).Children
	sibling := siblings[len(siblings)-1]
	siblingSubmit := httptest.NewRecorder()
	h.ServeHTTP(siblingSubmit, multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", childCookie(t, h, sibling.ID), "sibling-submit", nil, nil))
	if siblingSubmit.Code != http.StatusForbidden || !strings.Contains(siblingSubmit.Body.String(), "forbidden") {
		t.Fatalf("sibling submission: %d %s", siblingSubmit.Code, siblingSubmit.Body.String())
	}

	// At most 6 files per submission; the header sniffing only looks at the
	// first bytes, so eight magic bytes are a valid candidate.
	seven := map[string][]byte{}
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png", "e.png", "f.png", "g.png"} {
		seven[name] = pngMagic
	}
	tooMany := httptest.NewRecorder()
	h.ServeHTTP(tooMany, multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", child, "seven-files", nil, seven))
	if tooMany.Code != http.StatusBadRequest || !strings.Contains(tooMany.Body.String(), "too_many_files") {
		t.Fatalf("seven files: %d %s", tooMany.Code, tooMany.Body.String())
	}
	// A body that is not multipart fails inside ParseMultipartForm and is
	// reported as an oversize upload (there is no file to sniff).
	notMultipart := doJSON(t, h, "POST", "/api/v1/tasks/"+task.ID+"/submit", map[string]string{"note": "x"}, child, "not-multipart")
	if notMultipart.Code != http.StatusRequestEntityTooLarge || !strings.Contains(notMultipart.Body.String(), "upload_too_large") {
		t.Fatalf("non-multipart body: %d %s", notMultipart.Code, notMultipart.Body.String())
	}
	// The 100 MiB total cap is not exercised here: building such a body would
	// make the suite slow and memory hungry, so that branch is review-checked.

	var wg sync.WaitGroup
	codes := make(chan int, 2)
	requests := map[string]*http.Request{}
	for _, key := range []string{"concurrent-a", "concurrent-b"} {
		requests[key] = multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", child, key, nil, nil)
	}
	for key, request := range requests {
		wg.Add(1)
		go func(key string, request *http.Request) {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request)
			codes <- w.Code
		}(key, request)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent submission statuses=%v", counts)
	}
	var submissions int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM task_submissions WHERE task_instance_id=?`, task.ID).Scan(&submissions); err != nil {
		t.Fatal(err)
	}
	if submissions != 1 {
		t.Fatalf("submissions=%d, want 1", submissions)
	}
}

// The stats payload follows the requested family-local range: scheduled tasks
// are derived from the templates (so a historical window is not empty), the
// categories come from the confirmations inside it, and both stay scoped to the
// selected child — a sibling sees zeros, so a family aggregate would be caught.
func TestStatsFollowRequestedRangeScheduleAndCategories(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	state := getStateTest(t, h, parent)
	var task Task
	for _, candidate := range state.Tasks {
		if candidate.Status == "todo" {
			task = candidate
			break
		}
	}
	if task.ID == "" {
		t.Fatal("missing todo task")
	}
	child := childCookie(t, h, task.ChildID)
	type statsPayload struct {
		From           string `json:"from"`
		To             string `json:"to"`
		TotalTasks     int    `json:"totalTasks"`
		CompletedTasks int    `json:"completedTasks"`
		EarnedPoints   int    `json:"earnedPoints"`
		SpentPoints    int    `json:"spentPoints"`
		Daily          []struct {
			Date      string `json:"date"`
			Label     string `json:"label"`
			Completed int    `json:"completed"`
		} `json:"daily"`
		Categories []struct {
			Name    string `json:"name"`
			Count   int    `json:"count"`
			Percent int    `json:"percent"`
		} `json:"categories"`
	}
	readStats := func(path string) statsPayload {
		t.Helper()
		w := doJSON(t, h, "GET", path, nil, child, "")
		if w.Code != 200 {
			t.Fatalf("stats %s: %d %s", path, w.Code, w.Body.String())
		}
		var payload statsPayload
		if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	loc, err := time.LoadLocation(state.Timezone)
	if err != nil {
		t.Fatal(err)
	}
	todayTime := s.now().In(loc)
	today := todayTime.Format("2006-01-02")
	day := func(offset int) string {
		return time.Date(todayTime.Year(), todayTime.Month(), todayTime.Day()+offset, 0, 0, 0, 0, loc).Format("2006-01-02")
	}
	// The seed writes ten days of confirmations, so the expectations below are
	// relative to the baseline: what this test pins is that the range and the
	// categories follow the request, not how large the demo history is.
	baseline := readStats("/api/v1/stats")
	if want := day(-6); baseline.From != want || baseline.To != today {
		t.Fatalf("default window=%s..%s, want %s..%s", baseline.From, baseline.To, want, today)
	}
	if len(baseline.Daily) != 7 {
		t.Fatalf("daily=%d, want 7", len(baseline.Daily))
	}
	submit := httptest.NewRecorder()
	h.ServeHTTP(submit, multipartRequest(t, "POST", "/api/v1/tasks/"+task.ID+"/submit", child, "stats-submit", map[string]string{"note": "统计"}, nil))
	if submit.Code != 200 {
		t.Fatalf("submit: %d %s", submit.Code, submit.Body.String())
	}
	if w := doJSON(t, h, "POST", "/api/v1/tasks/"+task.ID+"/review", map[string]any{"approved": true}, parent, "stats-review"); w.Code != 200 {
		t.Fatalf("review: %d %s", w.Code, w.Body.String())
	}
	stats := readStats("/api/v1/stats")
	// The window ends today, and the approval is stamped now, so the last bucket
	// is the one that counts it.
	if stats.Daily[6].Completed != baseline.Daily[6].Completed+1 || stats.CompletedTasks != baseline.CompletedTasks+1 {
		t.Fatalf("today bucket=%+v summary=%+v baseline=%+v", stats.Daily[6], stats, baseline)
	}
	if stats.Daily[6].Label == "" || stats.To != today {
		t.Fatalf("today bucket=%+v", stats.Daily[6])
	}
	if stats.EarnedPoints != baseline.EarnedPoints+task.Points || stats.SpentPoints != 0 {
		t.Fatalf("earned=%d spent=%d, want %d and 0", stats.EarnedPoints, stats.SpentPoints, baseline.EarnedPoints+task.Points)
	}

	// One historical day: still scheduled work, which the old instance-based
	// count could not report because instances only exist for days that were
	// read. Its confirmations must equal the bucket the default window showed.
	yesterday := readStats("/api/v1/stats?from=" + day(-1) + "&to=" + day(-1))
	if len(yesterday.Daily) != 1 || yesterday.Daily[0].Date != day(-1) || yesterday.Daily[0].Label == "" {
		t.Fatalf("single day window=%+v", yesterday)
	}
	if yesterday.TotalTasks < 3 {
		t.Fatalf("scheduled tasks=%d on %s, want the seeded daily templates", yesterday.TotalTasks, day(-1))
	}
	if yesterday.CompletedTasks != baseline.Daily[5].Completed || yesterday.Daily[0].Completed != baseline.Daily[5].Completed {
		t.Fatalf("yesterday=%+v, default window bucket=%+v", yesterday, baseline.Daily[5])
	}
	// A day the seed never confirmed is empty in both counters; a three-day
	// window keeps one bucket per day.
	quiet := readStats("/api/v1/stats?from=" + day(-7) + "&to=" + day(-7))
	if quiet.CompletedTasks != 0 || quiet.EarnedPoints != 0 || len(quiet.Categories) != 0 {
		t.Fatalf("quiet day=%+v", quiet)
	}
	if span := readStats("/api/v1/stats?from=" + day(-3) + "&to=" + day(-1)); len(span.Daily) != 3 || span.Daily[0].Date != day(-3) {
		t.Fatalf("three-day window=%+v", span)
	}
	if single := readStats("/api/v1/stats?from=" + today + "&to=" + today); len(single.Daily) != 1 || single.Daily[0].Date != today {
		t.Fatalf("today only=%+v", single)
	}
	for _, path := range []string{
		"/api/v1/stats?from=" + day(-1),
		"/api/v1/stats?to=" + today,
		"/api/v1/stats?from=" + today + "&to=" + day(-1),
		"/api/v1/stats?from=" + day(-92) + "&to=" + today,
		"/api/v1/stats?from=2025-13-01&to=" + today,
	} {
		if w := doJSON(t, h, "GET", path, nil, child, ""); w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_request") {
			t.Fatalf("range %s: %d %s", path, w.Code, w.Body.String())
		}
	}

	// A category outside the fixed trio must reach the payload once a confirmed
	// task carries it, and the percentages must add up to the completions.
	created := doJSON(t, h, "POST", "/api/v1/tasks/", map[string]any{"childId": task.ChildID, "title": "跳跳绳", "description": "", "category": "运动健康", "points": 12, "repeatRule": "once", "repeatWeekday": 1}, parent, "")
	if created.Code != 200 {
		t.Fatalf("create task: %d %s", created.Code, created.Body.String())
	}
	var sports struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(created.Body).Decode(&sports); err != nil {
		t.Fatal(err)
	}
	submit = httptest.NewRecorder()
	h.ServeHTTP(submit, multipartRequest(t, "POST", "/api/v1/tasks/"+sports.ID+"/submit", child, "stats-sports", map[string]string{"note": "统计"}, nil))
	if submit.Code != 200 {
		t.Fatalf("submit sports: %d %s", submit.Code, submit.Body.String())
	}
	if w := doJSON(t, h, "POST", "/api/v1/tasks/"+sports.ID+"/review", map[string]any{"approved": true}, parent, "stats-sports-review"); w.Code != 200 {
		t.Fatalf("review sports: %d %s", w.Code, w.Body.String())
	}
	todayStats := readStats("/api/v1/stats?from=" + today + "&to=" + today)
	if todayStats.CompletedTasks != 2 {
		t.Fatalf("today completed=%d, want the two approvals", todayStats.CompletedTasks)
	}
	found, counted := false, 0
	for _, category := range todayStats.Categories {
		counted += category.Count
		if category.Percent != category.Count*100/todayStats.CompletedTasks {
			t.Fatalf("category=%+v of %d completions", category, todayStats.CompletedTasks)
		}
		if category.Name == "运动健康" && category.Count == 1 {
			found = true
		}
	}
	if !found || counted != todayStats.CompletedTasks {
		t.Fatalf("categories=%v of %d completions", todayStats.Categories, todayStats.CompletedTasks)
	}

	// A sibling's window is its own: no templates, no confirmations, no ledger.
	if w := doJSON(t, h, "POST", "/api/v1/children/", map[string]string{"name": "弟弟", "avatar": "★", "color": "#8f7bd2"}, parent, ""); w.Code != 200 {
		t.Fatalf("create sibling: %d %s", w.Code, w.Body.String())
	}
	siblings := getStateTest(t, h, parent).Children
	sibling := siblings[len(siblings)-1]
	if w := doJSON(t, h, "GET", "/api/v1/stats", nil, childCookie(t, h, sibling.ID), ""); w.Code != 200 {
		t.Fatalf("sibling stats: %d %s", w.Code, w.Body.String())
	} else {
		var siblingStats statsPayload
		if err := json.NewDecoder(w.Body).Decode(&siblingStats); err != nil {
			t.Fatal(err)
		}
		if siblingStats.TotalTasks != 0 || siblingStats.CompletedTasks != 0 || siblingStats.EarnedPoints != 0 || siblingStats.SpentPoints != 0 || len(siblingStats.Categories) != 0 {
			t.Fatalf("sibling saw another child's window: %+v", siblingStats)
		}
	}
}

func TestHealthEndpointsReportLivenessReadinessAndVersion(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(Config{DBPath: filepath.Join(dir, "health.db"), MediaDir: filepath.Join(dir, "media"), Version: "test-1"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	h := s.Handler()
	live := httptest.NewRecorder()
	h.ServeHTTP(live, httptest.NewRequest("GET", "/health/live", nil))
	if live.Code != 200 || !strings.Contains(live.Body.String(), `"version":"test-1"`) {
		t.Fatalf("live: %d %s", live.Code, live.Body.String())
	}
	// A database without a family is a legitimate startup state: the SPA answers
	// no_family, so readiness holds there too.
	ready := httptest.NewRecorder()
	h.ServeHTTP(ready, httptest.NewRequest("GET", "/health/ready", nil))
	if ready.Code != 200 {
		t.Fatalf("ready without a family: %d %s", ready.Code, ready.Body.String())
	}
	if err = s.CreateFamily(context.Background(), FamilyInput{Code: "DEMO", Name: "Demo", Username: "parent", Password: "2468"}); err != nil {
		t.Fatal(err)
	}
	ready = httptest.NewRecorder()
	h.ServeHTTP(ready, httptest.NewRequest("GET", "/health/ready", nil))
	if ready.Code != 200 {
		t.Fatalf("ready with a family: %d %s", ready.Code, ready.Body.String())
	}
	// A dead database must not report ready.
	if err = s.db.Close(); err != nil {
		t.Fatal(err)
	}
	ready = httptest.NewRecorder()
	h.ServeHTTP(ready, httptest.NewRequest("GET", "/health/ready", nil))
	if ready.Code != http.StatusServiceUnavailable || !strings.Contains(ready.Body.String(), "unavailable") {
		t.Fatalf("ready after close: %d %s", ready.Code, ready.Body.String())
	}
}

// Creating a task answers with the instance id every later route addresses, and
// an instance that /state can actually list: the response used to be able to
// carry an empty id while the failure was swallowed.
func TestCreateTaskAnswersWithAListableInstance(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	childID := getStateTest(t, h, parent).Children[0].ID
	w := doJSON(t, h, "POST", "/api/v1/tasks/", map[string]any{"childId": childID, "title": "审计任务", "description": "", "category": "生活自理", "points": 5, "repeatRule": "daily", "repeatWeekday": 1}, parent, "")
	if w.Code != 200 {
		t.Fatalf("create task: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" {
		t.Fatal("created task id is empty")
	}
	var found Task
	for _, candidate := range getStateTest(t, h, parent).Tasks {
		if candidate.ID == created.ID {
			found = candidate
		}
	}
	if found.Title != "审计任务" || found.Status != "todo" || found.ChildID != childID {
		t.Fatalf("created instance %+v", found)
	}
}

func TestReviewCreditsExactlyOnceUsesMinimumGrowthAndRedemptionCannotOverdraw(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	cookie := parentCookie(t, h)
	state := getStateTest(t, h, cookie)
	var pending Task
	for _, v := range state.Tasks {
		if v.Status == "pending_review" {
			pending = v
			break
		}
	}
	if pending.ID == "" {
		t.Fatal("missing pending task")
	}
	pending.Points = 1
	if _, err := s.db.Exec(`UPDATE task_instances SET points=1 WHERE id=?`, pending.ID); err != nil {
		t.Fatal(err)
	}
	var experienceBefore int
	if err := s.db.QueryRow(`SELECT experience FROM children WHERE id=?`, pending.ChildID).Scan(&experienceBefore); err != nil {
		t.Fatal(err)
	}
	before := 0
	for _, c := range state.Children {
		if c.ID == pending.ChildID {
			before = c.PointsBalance
		}
	}
	// 备注和手动积分、提交说明共用 30 字预算：超了直接 400，不进事务也不占幂等键。
	if w := doJSON(t, h, "POST", "/api/v1/tasks/"+pending.ID+"/review", map[string]any{"approved": true, "note": strings.Repeat("长", 31)}, cookie, "review-note"); w.Code != 400 {
		t.Fatalf("long review note: %d %s", w.Code, w.Body.String())
	}
	w := doJSON(t, h, "POST", "/api/v1/tasks/"+pending.ID+"/review", map[string]any{"approved": true, "note": "ok"}, cookie, "review-1")
	if w.Code != 200 {
		t.Fatalf("review: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(t, h, "POST", "/api/v1/tasks/"+pending.ID+"/review", map[string]any{"approved": true}, cookie, "review-1")
	if w.Code != 200 {
		t.Fatalf("replay: %d", w.Code)
	}
	state = getStateTest(t, h, cookie)
	after := 0
	for _, c := range state.Children {
		if c.ID == pending.ChildID {
			after = c.PointsBalance
		}
	}
	if after != before+pending.Points {
		t.Fatalf("balance %d, want %d", after, before+pending.Points)
	}
	var experienceAfter int
	if err := s.db.QueryRow(`SELECT experience FROM children WHERE id=?`, pending.ChildID).Scan(&experienceAfter); err != nil {
		t.Fatal(err)
	}
	if experienceAfter != experienceBefore+1 {
		t.Fatalf("experience=%d, want %d", experienceAfter, experienceBefore+1)
	}
	var expensive Wish
	for _, v := range state.Wishes {
		if v.PointsCost > after {
			expensive = v
			break
		}
	}
	if expensive.ID == "" {
		t.Fatal("missing expensive wish")
	}
	childCookie := childCookie(t, h, pending.ChildID)
	w = doJSON(t, h, "POST", "/api/v1/wishes/"+expensive.ID+"/redeem", map[string]any{}, childCookie, "redeem-too-much")
	if w.Code != 409 {
		t.Fatalf("overdraw status %d", w.Code)
	}
	state = getStateTest(t, h, cookie)
	for _, c := range state.Children {
		if c.ID == pending.ChildID && c.PointsBalance != after {
			t.Fatal("failed redemption changed balance")
		}
	}
}

func TestWishCompletionIsChildOnlyReversibleAndScopedToTheChild(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	state := getStateTest(t, h, parent)
	if len(state.Children) != 1 {
		t.Fatalf("seeded children=%d, want 1", len(state.Children))
	}
	mia := state.Children[0]
	var affordable Wish
	for _, v := range state.Wishes {
		if v.PointsCost <= mia.PointsBalance {
			affordable = v
			break
		}
	}
	if affordable.ID == "" {
		t.Fatal("missing affordable wish")
	}
	// The demo family seeds a single child, so the "another child" checks below
	// create the second profile through the parent API.
	w := doJSON(t, h, "POST", "/api/v1/children/", map[string]string{"name": "乐乐", "avatar": "🚀", "color": "#55b8a4"}, parent, "")
	if w.Code != 200 {
		t.Fatalf("create second child: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	leo := childCookie(t, h, created.ID)
	child := childCookie(t, h, mia.ID)
	// 一次不带 isActive 的编辑不能把心愿悄悄下架：PUT 只改它收到的字段。
	if w := doJSON(t, h, "PUT", "/api/v1/wishes/"+affordable.ID, map[string]any{
		"title": affordable.Title, "description": affordable.Description,
		"pointsCost": affordable.PointsCost, "icon": affordable.Icon, "color": affordable.Color,
	}, parent, ""); w.Code != 200 {
		t.Fatalf("edit wish without isActive: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(t, h, "POST", "/api/v1/wishes/"+affordable.ID+"/redeem", map[string]any{}, child, "complete-redeem")
	if w.Code != 200 {
		t.Fatalf("redeem: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, child)
	if len(state.Redemptions) != 1 {
		t.Fatalf("redemptions=%d, want 1", len(state.Redemptions))
	}
	rid := state.Redemptions[0].ID
	if state.Redemptions[0].CompletedAt != nil {
		t.Fatal("new redemption is already completed")
	}
	if state.Redemptions[0].WishTitle != affordable.Title {
		t.Fatalf("wish title %q, want %q", state.Redemptions[0].WishTitle, affordable.Title)
	}
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01")
	complete := func(id string, cookie *http.Cookie, fields map[string]string, files map[string][]byte) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, multipartRequest(t, "PATCH", "/api/v1/redemptions/"+id, cookie, "", fields, files))
		return rec
	}
	note := "已经听到加长版的故事啦"
	done := map[string]string{"completed": "true", "note": note}
	if w = complete(rid, parent, done, nil); w.Code != 403 {
		t.Fatalf("parent completion: %d %s", w.Code, w.Body.String())
	}
	if w = complete(rid, leo, done, nil); w.Code != 404 {
		t.Fatalf("other child completion: %d %s", w.Code, w.Body.String())
	}
	if w = complete("red_missing", child, done, nil); w.Code != 404 {
		t.Fatalf("unknown redemption: %d %s", w.Code, w.Body.String())
	}
	if w = complete(rid, child, done, map[string][]byte{"wish-proof.png": png}); w.Code != 204 {
		t.Fatalf("complete: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, child)
	if state.Redemptions[0].CompletedAt == nil {
		t.Fatal("completion not recorded")
	}
	if state.Redemptions[0].CompletedNote != note {
		t.Fatalf("note %q, want %q", state.Redemptions[0].CompletedNote, note)
	}
	if len(state.Redemptions[0].Attachments) != 1 {
		t.Fatalf("attachments=%d, want 1", len(state.Redemptions[0].Attachments))
	}
	evidence := state.Redemptions[0].Attachments[0]
	media := httptest.NewRequest("GET", evidence.URL, nil)
	media.AddCookie(child)
	served := httptest.NewRecorder()
	h.ServeHTTP(served, media)
	if served.Code != 200 || served.Body.String() != string(png) || !strings.Contains(served.Header().Get("Content-Type"), "png") {
		t.Fatalf("evidence media: %d %q %q", served.Code, served.Header().Get("Content-Type"), served.Body.String())
	}
	if other := getStateTest(t, h, leo); len(other.Redemptions) != 0 {
		t.Fatalf("other child sees %d redemptions", len(other.Redemptions))
	}
	if w = complete(rid, child, map[string]string{"completed": "false"}, nil); w.Code != 204 {
		t.Fatalf("undo: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, child)
	if state.Redemptions[0].CompletedAt != nil || state.Redemptions[0].CompletedNote != "" || len(state.Redemptions[0].Attachments) != 0 {
		t.Fatalf("undo kept the completion record: %+v", state.Redemptions[0])
	}
	served = httptest.NewRecorder()
	h.ServeHTTP(served, media)
	if served.Code != 404 {
		t.Fatalf("removed evidence is still served: %d", served.Code)
	}
}

func TestFamilyIsolationAndLastChildProtection(t *testing.T) {
	s := testServer(t)
	otherFamily := otherFamily(t, s, "OTHER", "Asia/Shanghai")
	if _, err := s.db.Exec(`INSERT INTO children(id,family_id,name,avatar,color,level,experience,points_balance,created_at) VALUES('child-other',?,'Other child','⭐','#ffb547',1,0,0,?)`, otherFamily, nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	cookie := parentCookie(t, h)
	state := getStateTest(t, h, cookie)
	if len(state.Children) != 1 {
		t.Fatalf("seeded children=%d, want 1", len(state.Children))
	}
	seeded := state.Children[0].ID
	w := doJSON(t, h, "POST", "/api/v1/children/", map[string]string{"name": "Second", "avatar": "⭐", "color": "#ffb547"}, cookie, "")
	if w.Code != 200 {
		t.Fatalf("create second child: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, cookie)
	if len(state.Children) != 2 {
		t.Fatalf("children=%d, want 2", len(state.Children))
	}
	for _, c := range state.Children {
		if c.ID == seeded {
			continue
		}
		if w = doJSON(t, h, "DELETE", "/api/v1/children/"+c.ID, nil, cookie, ""); w.Code != 204 {
			t.Fatalf("delete: %d %s", w.Code, w.Body.String())
		}
	}
	state = getStateTest(t, h, cookie)
	w = doJSON(t, h, "DELETE", "/api/v1/children/"+seeded, nil, cookie, "")
	if w.Code != 409 {
		t.Fatalf("last child status=%d", w.Code)
	}
	// The app only opens sessions for the family it serves, so a second family
	// is reached through a session row the test writes itself.
	other := getStateTest(t, h, sessionFor(t, s, otherFamily, "parent", "par-other", "child-other"))
	if len(other.Children) != 1 || other.Children[0].ID != "child-other" || len(other.Tasks) != 0 || len(other.Ledger) != 0 {
		t.Fatalf("other family state leaked: %d children, %d tasks, %d ledger", len(other.Children), len(other.Tasks), len(other.Ledger))
	}
}

func TestParentPasswordBudgetThrottlesGuessingWithoutLockingOutTheFamily(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	attempt := func(password string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"password": password}, nil, "")
	}
	guesses := 0
	for range authFailBurst + 5 {
		w := attempt("wrong-password")
		if w.Code == 429 {
			break
		}
		if w.Code != 401 {
			t.Fatalf("unexpected status while guessing: %d %s", w.Code, w.Body.String())
		}
		guesses++
	}
	if guesses > authFailBurst {
		t.Fatalf("guessing was never throttled after %d attempts", guesses)
	}
	w := attempt("wrong-password")
	if w.Code != 429 || !strings.Contains(w.Body.String(), "too_many_requests") {
		t.Fatalf("throttled response: %d %s", w.Code, w.Body.String())
	}
	// The correct password is never charged, so guessing cannot lock the
	// family out of its own parent end.
	if ok := attempt("2468"); ok.Code != 200 {
		t.Fatalf("correct password blocked by the failure budget: %d %s", ok.Code, ok.Body.String())
	}
	// The child end carries no credential and is not part of that budget.
	if child := doJSON(t, h, "POST", "/api/v1/auth/child", nil, nil, ""); child.Code != 200 {
		t.Fatalf("child end blocked by the parent budget: %d %s", child.Code, child.Body.String())
	}
}

func TestParentPasswordChangeRequiresTheCurrentPasswordAndReplacesTheFamilyCredential(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	change := func(cookie *http.Cookie, current, next string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/auth/parent/password", map[string]string{"currentPassword": current, "newPassword": next}, cookie, "")
	}
	unlock := func(password string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"password": password}, nil, "")
	}
	if w := change(nil, "2468", "1357"); w.Code != 401 || !strings.Contains(w.Body.String(), "unauthorized") {
		t.Fatalf("change without a session: %d %s", w.Code, w.Body.String())
	}
	if w := change(childCookie(t, h, ""), "2468", "1357"); w.Code != 403 || !strings.Contains(w.Body.String(), "forbidden") {
		t.Fatalf("child end changed the parent password: %d %s", w.Code, w.Body.String())
	}
	parent := parentCookie(t, h)
	if w := change(parent, "0000", "1357"); w.Code != 401 || !strings.Contains(w.Body.String(), "invalid_credentials") {
		t.Fatalf("wrong current password: %d %s", w.Code, w.Body.String())
	}
	// The new password is checked before any argon2 comparison, so a malformed
	// one is refused without spending the failure budget.
	for _, next := range []string{"123", "12345", "12a4"} {
		if w := change(parent, "2468", next); w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_request") {
			t.Fatalf("new password %q: %d %s", next, w.Code, w.Body.String())
		}
	}
	if w := unlock("2468"); w.Code != 200 {
		t.Fatalf("format rejections locked the family out: %d %s", w.Code, w.Body.String())
	}
	if w := change(parent, "2468", "1357"); w.Code != 204 {
		t.Fatalf("change: %d %s", w.Code, w.Body.String())
	}
	if w := unlock("2468"); w.Code != 401 {
		t.Fatalf("old password still unlocks: %d %s", w.Code, w.Body.String())
	}
	if w := unlock("1357"); w.Code != 200 || !strings.Contains(w.Body.String(), `"role":"parent"`) {
		t.Fatalf("new password refused: %d %s", w.Code, w.Body.String())
	}
	ctx := context.Background()
	var hash string
	if err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM parents WHERE family_id=(SELECT id FROM families WHERE code='DEMO') ORDER BY id LIMIT 1`).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash == "1357" {
		t.Fatal("the parent password was stored in clear text")
	}
	if ok, err := s.verifyPassword(ctx, hash, "1357"); err != nil || !ok {
		t.Fatalf("stored hash does not verify the new password: ok=%v err=%v", ok, err)
	}
	if ok, err := s.verifyPassword(ctx, hash, "2468"); err != nil || ok {
		t.Fatalf("stored hash still verifies the old password: ok=%v err=%v", ok, err)
	}
	// Sessions are deliberately untouched: the parent that changed the password
	// is not thrown out of the end it is already in.
	if state := getStateTest(t, h, parent); state.Role != "parent" {
		t.Fatalf("parent session lost its role: %s", state.Role)
	}
	// CreateFamily enforces the same format.
	if err := s.CreateFamily(ctx, FamilyInput{Code: "OTHER", Name: "Other", Username: "parent", Password: "123"}); err == nil {
		t.Fatal("CreateFamily accepted a 3-digit password")
	}
	if err := s.CreateFamily(ctx, FamilyInput{Code: "OTHER", Name: "Other", Username: "parent", Password: "12a4"}); err == nil {
		t.Fatal("CreateFamily accepted a non-numeric password")
	}
	// Sign-in never checks the format, so a credential written before this rule
	// keeps working: a long-password parent row still unlocks the family.
	legacy, err := s.hashPassword(ctx, "growjoy2468")
	if err != nil {
		t.Fatal(err)
	}
	var family string
	if err = s.db.QueryRowContext(ctx, `SELECT id FROM families WHERE code='DEMO'`).Scan(&family); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, `INSERT INTO parents(id,family_id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)`, id("par"), family, "legacy", "Legacy parent", legacy, nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	if w := unlock("growjoy2468"); w.Code != 200 {
		t.Fatalf("legacy long password refused: %d %s", w.Code, w.Body.String())
	}
}

func TestChildEndIsTheDefaultAndThePasswordGatesTheManagementApi(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	w := doJSON(t, h, "POST", "/api/v1/auth/child", nil, nil, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"role":"child"`) {
		t.Fatalf("child end: %d %s", w.Code, w.Body.String())
	}
	child := w.Result().Cookies()[0]
	if state := getStateTest(t, h, child); state.Role != "child" || len(state.Children) != 1 {
		t.Fatalf("child state: role=%s children=%d", state.Role, len(state.Children))
	}
	if w = doJSON(t, h, "POST", "/api/v1/children/", map[string]string{"name": "小安", "avatar": "⭐", "color": "#ffb547"}, child, ""); w.Code != 403 {
		t.Fatalf("child end created a profile: %d %s", w.Code, w.Body.String())
	}
	if w = doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"password": "wrong-password"}, child, ""); w.Code != 401 {
		t.Fatalf("wrong password status=%d", w.Code)
	}
	w = doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"password": "2468"}, child, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"role":"parent"`) {
		t.Fatalf("parent unlock: %d %s", w.Code, w.Body.String())
	}
	parent := w.Result().Cookies()[0]
	state := getStateTest(t, h, parent)
	if state.Role != "parent" {
		t.Fatalf("parent role=%s", state.Role)
	}
	// Entering the parent end spends the child session, so the password is
	// needed again next time rather than being restorable from the cookie.
	if replaced := doJSON(t, h, "GET", "/api/v1/state", nil, child, ""); replaced.Code != 401 {
		t.Fatalf("replaced child session still works: %d", replaced.Code)
	}
	back := doJSON(t, h, "POST", "/api/v1/auth/child", nil, parent, "")
	if back.Code != 200 {
		t.Fatalf("back to the child end: %d %s", back.Code, back.Body.String())
	}
	demoted := back.Result().Cookies()[0]
	if state = getStateTest(t, h, demoted); state.Role != "child" {
		t.Fatalf("demoted role=%s", state.Role)
	}
	if w = doJSON(t, h, "DELETE", "/api/v1/children/"+state.Children[0].ID, nil, demoted, ""); w.Code != 403 {
		t.Fatalf("demoted session kept parent access: %d %s", w.Code, w.Body.String())
	}
	var sessions int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("sessions=%d, want 1", sessions)
	}
}

func TestChildEndWithoutAFamilyIsRefused(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(Config{DBPath: filepath.Join(dir, "empty.db"), MediaDir: filepath.Join(dir, "media")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w := doJSON(t, s.Handler(), "POST", "/api/v1/auth/child", nil, nil, "")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "no_family") {
		t.Fatalf("child end without a family: %d %s", w.Code, w.Body.String())
	}
}

func TestSaturatedHashGateShedsLoad(t *testing.T) {
	s := testServer(t)
	for range argon2Slots {
		s.hashGate <- struct{}{}
	}
	r := httptest.NewRequest("POST", "/api/v1/auth/parent", strings.NewReader(`{"password":"2468"}`))
	r.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(r.Context(), 50*time.Millisecond)
	defer cancel()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r.WithContext(ctx))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "unavailable") {
		t.Fatalf("saturated gate response: %d %s", w.Code, w.Body.String())
	}
	var sessions int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("shed request created %d sessions", sessions)
	}
}

func TestSweepReclaimsExpiredSessionsAndStaleKeys(t *testing.T) {
	s := testServer(t)
	parentCookie(t, s.Handler())
	count := func(query string) int {
		t.Helper()
		var n int
		if err := s.db.QueryRow(query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	insert := func(key, created string) {
		t.Helper()
		if _, err := s.db.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) SELECT id,'par','review',?,200,'{}',? FROM families WHERE code='DEMO'`, key, created); err != nil {
			t.Fatal(err)
		}
	}
	insert("stale", nowText(s.now().Add(-idempotencyRetention-time.Hour)))
	if err := s.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT COUNT(*) FROM sessions`); n != 1 {
		t.Fatalf("sweep removed a live session: %d", n)
	}
	s.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	insert("fresh", nowText(s.now()))
	if err := s.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Fatalf("expired sessions survived sweep: %d", n)
	}
	if n := count(`SELECT COUNT(*) FROM idempotency_keys WHERE key='stale'`); n != 0 {
		t.Fatalf("stale idempotency key survived sweep")
	}
	if n := count(`SELECT COUNT(*) FROM idempotency_keys WHERE key='fresh'`); n != 1 {
		t.Fatalf("retained idempotency key was swept")
	}
}

func TestInternalErrorsAreLoggedNotLeakedAndPanicsAreRecovered(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	panicking := recoverPanic(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom: dsn=/srv/secret.db")
	}))
	w := httptest.NewRecorder()
	panicking.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/state", nil))
	if w.Code != 500 {
		t.Fatalf("panic status %d", w.Code)
	}
	if body := w.Body.String(); strings.Contains(body, "secret.db") || strings.Contains(body, "boom") {
		t.Fatalf("panic detail leaked: %s", body)
	}
	if !strings.Contains(logs.String(), "secret.db") {
		t.Fatalf("panic was not logged: %s", logs.String())
	}

	committed := recoverPanic(logger, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"ok": "yes"})
		panic("after commit")
	}))
	w = httptest.NewRecorder()
	committed.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/state", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "yes") {
		t.Fatalf("committed response rewritten: %d %s", w.Code, w.Body.String())
	}

	logs.Reset()
	s := testServer(t)
	s.log = logger
	w = httptest.NewRecorder()
	s.internalError(w, httptest.NewRequest("GET", "/api/v1/state", nil), errors.New("sql: no such column: secret_column"))
	if !strings.Contains(w.Body.String(), "internal") || strings.Contains(w.Body.String(), "secret_column") {
		t.Fatalf("internal error leaked: %s", w.Body.String())
	}
	if !strings.Contains(logs.String(), "secret_column") {
		t.Fatalf("internal error was not logged: %s", logs.String())
	}
}

func TestParentPointsAdjustmentIsIdempotentScopedAndCreditsGrowth(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	state := getStateTest(t, h, parent)
	if len(state.Children) != 1 {
		t.Fatalf("seeded children=%d, want 1", len(state.Children))
	}
	mia := state.Children[0]
	body := map[string]any{"amount": 30, "note": "主动整理客厅"}
	w := doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", body, parent, "award-points-1")
	if w.Code != 200 {
		t.Fatalf("award: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, parent)
	awarded := state.Children[0]
	if awarded.PointsBalance != mia.PointsBalance+30 {
		t.Fatalf("balance=%d, want %d", awarded.PointsBalance, mia.PointsBalance+30)
	}
	// The API exposes experience modulo 100; an award grows it by max(amount/5, 1).
	if want := math.Mod(mia.Experience+6, 100); awarded.Experience != want {
		t.Fatalf("experience=%v, want %v", awarded.Experience, want)
	}
	var manual Ledger
	for _, v := range state.Ledger {
		if v.ReferenceType == "manual" {
			manual = v
		}
	}
	if manual.Amount != 30 || manual.Type != "earned" || manual.ChildID != mia.ID || manual.Description != "家长奖励：主动整理客厅" {
		t.Fatalf("unexpected ledger entry %+v", manual)
	}
	// The same key replays: the marker comes back and nothing is credited twice.
	ledgerCount := len(state.Ledger)
	w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", body, parent, "award-points-1")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatalf("replay: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, parent)
	if state.Children[0].PointsBalance != mia.PointsBalance+30 || len(state.Ledger) != ledgerCount {
		t.Fatalf("replayed award credited twice: balance=%d ledger=%d", state.Children[0].PointsBalance, len(state.Ledger))
	}
	// A deduction only moves points_balance; experience never decreases.
	w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", map[string]any{"amount": -20}, parent, "award-points-2")
	if w.Code != 200 {
		t.Fatalf("deduct: %d %s", w.Code, w.Body.String())
	}
	state = getStateTest(t, h, parent)
	deducted := state.Children[0]
	if deducted.PointsBalance != mia.PointsBalance+10 || deducted.Experience != awarded.Experience {
		t.Fatalf("deduct: balance=%d experience=%v", deducted.PointsBalance, deducted.Experience)
	}
	// Ledger rows are ordered by created_at, which is not a reliable second-order
	// key, so match on the description rather than on the last element.
	var spent Ledger
	for _, v := range state.Ledger {
		if v.Description == "家长扣除" {
			spent = v
		}
	}
	if spent.Amount != -20 || spent.Type != "spent" || spent.ReferenceType != "manual" {
		t.Fatalf("unexpected deduction entry %+v", spent)
	}
	// More than the child owns is refused instead of driving the CHECK negative.
	w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", map[string]any{"amount": -maxPointsAdjustment}, parent, "award-points-3")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "insufficient_balance") {
		t.Fatalf("overdraw: %d %s", w.Code, w.Body.String())
	}
	for _, bad := range []int{0, maxPointsAdjustment + 1, -maxPointsAdjustment - 1} {
		if w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", map[string]any{"amount": bad}, parent, "bad-amount"); w.Code != 400 {
			t.Fatalf("amount %d: %d %s", bad, w.Code, w.Body.String())
		}
	}
	if w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", map[string]any{"amount": 5, "note": strings.Repeat("长", 31)}, parent, "bad-note"); w.Code != 400 {
		t.Fatalf("long note: %d %s", w.Code, w.Body.String())
	}
	if w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", body, parent, ""); w.Code != 400 || !strings.Contains(w.Body.String(), "idempotency_required") {
		t.Fatalf("missing key: %d %s", w.Code, w.Body.String())
	}
	if w = doJSON(t, h, "POST", "/api/v1/children/child_missing/points", body, parent, "award-missing"); w.Code != 404 {
		t.Fatalf("unknown child: %d %s", w.Code, w.Body.String())
	}
	if w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", body, childCookie(t, h, mia.ID), "award-child"); w.Code != 403 {
		t.Fatalf("child actor: %d %s", w.Code, w.Body.String())
	}
	// A parent of another family cannot reach this child even with its id.
	// CreateFamily refuses a second family (this deployment only ever serves the
	// oldest row), so the foreign family is inserted directly: isolation has to
	// hold for any families row, however it got there.
	other := sessionFor(t, s, otherFamily(t, s, "OTHER", "Asia/Shanghai"), "parent", "par-other", "")
	if w = doJSON(t, h, "POST", "/api/v1/children/"+mia.ID+"/points", body, other, "award-other"); w.Code != 404 {
		t.Fatalf("cross family award: %d %s", w.Code, w.Body.String())
	}
}

// homeworkFile keeps the upload order deterministic: multipartRequest takes a
// map, and the order the parts arrive in is the order the media renders in.
type homeworkFile struct {
	name    string
	content []byte
}

func homeworkRequest(t *testing.T, method, path string, cookie *http.Cookie, fields [][2]string, files []homeworkFile) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range files {
		part, err := writer.CreateFormFile("files", file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(file.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	if cookie != nil {
		r.AddCookie(cookie)
	}
	return r
}

func runHomework(t *testing.T, h http.Handler, method, path string, cookie *http.Cookie, fields [][2]string, files []homeworkFile) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, homeworkRequest(t, method, path, cookie, fields, files))
	return rec
}

// solidPNG is a decodable image: pngMagic is only a header, and the homework
// pipeline really decodes whatever it is handed.
func solidPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.Set(x, y, color.RGBA{R: 40, G: 120, B: 200, A: 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// jpegWithOrientation builds a width×height JPEG and splices an APP1/EXIF
// segment holding only the orientation tag right after the SOI marker — the
// layout imaging.readOrientation expects (MM byte order, single IFD0 entry).
func jpegWithOrientation(t *testing.T, width, height int, orientation uint16) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.Set(x, y, color.RGBA{R: 200, G: 40, B: 40, A: 255})
		}
	}
	var raw bytes.Buffer
	if err := jpeg.Encode(&raw, img, nil); err != nil {
		t.Fatal(err)
	}
	ifd := []byte{0x00, 0x01,
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, byte(orientation), 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00}
	exif := append([]byte("Exif\x00\x00MM\x00*\x00\x00\x00\x08"), ifd...)
	app1 := append([]byte{0xff, 0xe1, byte((len(exif) + 2) >> 8), byte(len(exif) + 2)}, exif...)
	out := append([]byte{0xff, 0xd8}, app1...)
	return append(out, raw.Bytes()[2:]...)
}

// fakeMP4 is the smallest body isMP4 accepts: a 24-byte ftyp box.
func fakeMP4() []byte {
	out := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2',
		'm', 'p', '4', '2', 'i', 's', 'o', 'm', 0x00, 0x00, 0x00, 0x01}
	return out
}

func homeworkDay(t *testing.T, h http.Handler, cookie *http.Cookie, date string) HomeworkDay {
	t.Helper()
	w := doJSON(t, h, "GET", "/api/v1/homework/?date="+date, nil, cookie, "")
	if w.Code != 200 {
		t.Fatalf("homework day: %d %s", w.Code, w.Body.String())
	}
	var day HomeworkDay
	if err := json.NewDecoder(w.Body).Decode(&day); err != nil {
		t.Fatal(err)
	}
	return day
}

func TestHomeworkStoresNormalizedMediaAndServesItToBothEnds(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	child := childCookie(t, h, "")
	date := "2026-05-04"
	clip := fakeMP4()
	w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", date}, {"subject", "语文"}, {"description", "抄写第三课生字各三遍"},
	}, []homeworkFile{
		{name: "portrait.jpg", content: jpegWithOrientation(t, 40, 20, 6)},
		{name: "flat.png", content: solidPNG(t, 8, 8)},
		{name: "wide.png", content: solidPNG(t, 2600, 4)},
		{name: "clip.mp4", content: clip},
	})
	if w.Code != 200 {
		t.Fatalf("create homework: %d %s", w.Code, w.Body.String())
	}
	day := homeworkDay(t, h, parent, date)
	if len(day.Items) != 1 {
		t.Fatalf("items=%d, want 1", len(day.Items))
	}
	if day.Date != date || day.Items[0].Subject != "语文" || day.Items[0].Description != "抄写第三课生字各三遍" {
		t.Fatalf("unexpected item: %+v", day.Items[0])
	}
	media := day.Items[0].Media
	if len(media) != 4 {
		t.Fatalf("media=%d, want 4", len(media))
	}
	for i, want := range []string{"portrait.jpg", "flat.png", "wide.png", "clip.mp4"} {
		if media[i].Name != want {
			t.Fatalf("media[%d].name=%q, want %q", i, media[i].Name, want)
		}
		if !strings.HasPrefix(media[i].URL, "/api/v1/media/") {
			t.Fatalf("media[%d].url=%q", i, media[i].URL)
		}
	}
	if media[0].Type != "image" || media[1].Type != "image" || media[2].Type != "image" || media[3].Type != "video" {
		t.Fatalf("unexpected media types: %+v", media)
	}
	fetch := func(url string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", url, nil)
		r.AddCookie(cookie)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}
	decode := func(rec *httptest.ResponseRecorder) image.Image {
		t.Helper()
		img, format, err := image.Decode(bytes.NewReader(rec.Body.Bytes()))
		if err != nil {
			t.Fatalf("stored media is not decodable: %v", err)
		}
		if format != "jpeg" {
			t.Fatalf("stored image format=%q, want jpeg", format)
		}
		return img
	}
	// The child end reads the same media the parent uploaded.
	portrait := fetch(media[0].URL, child)
	if portrait.Code != 200 || !strings.Contains(portrait.Header().Get("Content-Type"), "image/jpeg") {
		t.Fatalf("portrait: %d %q", portrait.Code, portrait.Header().Get("Content-Type"))
	}
	rotated := decode(portrait)
	if rotated.Bounds().Dx() != 20 || rotated.Bounds().Dy() != 40 {
		t.Fatalf("EXIF orientation not applied: %dx%d, want 20x40", rotated.Bounds().Dx(), rotated.Bounds().Dy())
	}
	// A PNG is re-encoded as JPEG too, and neither image is ever enlarged.
	flat := fetch(media[1].URL, child)
	if flat.Code != 200 || !strings.Contains(flat.Header().Get("Content-Type"), "image/jpeg") {
		t.Fatalf("flat png: %d %q", flat.Code, flat.Header().Get("Content-Type"))
	}
	if bounds := decode(flat).Bounds(); bounds.Dx() != 8 || bounds.Dy() != 8 {
		t.Fatalf("small image was resized: %dx%d, want 8x8", bounds.Dx(), bounds.Dy())
	}
	// Anything past 2560 on the longest edge is scaled down, aspect ratio kept.
	wide := decode(fetch(media[2].URL, child))
	if wide.Bounds().Dx() != homeworkMaxEdge || wide.Bounds().Dy() != 3 {
		t.Fatalf("wide image %dx%d, want %dx3", wide.Bounds().Dx(), wide.Bounds().Dy(), homeworkMaxEdge)
	}
	// Videos are stored byte for byte, no transcoding.
	video := fetch(media[3].URL, child)
	if video.Code != 200 || !strings.Contains(video.Header().Get("Content-Type"), "video/mp4") {
		t.Fatalf("video: %d %q", video.Code, video.Header().Get("Content-Type"))
	}
	if !bytes.Equal(video.Body.Bytes(), clip) {
		t.Fatalf("video bytes changed: %d bytes, want %d", video.Body.Len(), len(clip))
	}
	// Another family sees neither the entry nor its media.
	foreign := sessionFor(t, s, otherFamily(t, s, "OTHER", "Asia/Shanghai"), "parent", "par-other", "")
	if other := homeworkDay(t, h, foreign, date); len(other.Items) != 0 {
		t.Fatalf("other family sees %d items", len(other.Items))
	}
	if other := fetch(media[0].URL, foreign); other.Code != 404 {
		t.Fatalf("cross family media: %d", other.Code)
	}
}

func TestHomeworkIsParentOnlyAndValidatesSubjectEditAndDelete(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	child := childCookie(t, h, "")
	date := "2026-05-05"
	fields := func(description string) [][2]string {
		return [][2]string{{"date", date}, {"subject", "数学"}, {"description", description}}
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", child, fields("写口算"), nil); w.Code != 403 {
		t.Fatalf("child create: %d %s", w.Code, w.Body.String())
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{{"date", date}, {"subject", "体育课"}, {"description", "跳绳"}}, nil); w.Code != 400 {
		t.Fatalf("unknown subject: %d %s", w.Code, w.Body.String())
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{{"date", "2026-13-01"}, {"subject", "数学"}, {"description", "写口算"}}, nil); w.Code != 400 {
		t.Fatalf("bad date: %d %s", w.Code, w.Body.String())
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{{"date", date}, {"subject", "数学"}}, nil); w.Code != 400 {
		t.Fatalf("empty homework: %d %s", w.Code, w.Body.String())
	}
	// 上传预算与任务提交一致：超过 6 个文件当场拒绝，不往磁盘无限写。
	tooMany := make([]homeworkFile, 0, 7)
	for i := 0; i < 7; i++ {
		tooMany = append(tooMany, homeworkFile{name: fmt.Sprintf("many-%d.png", i), content: solidPNG(t, 4, 4)})
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, fields("太多附件"), tooMany); w.Code != 400 {
		t.Fatalf("too many files: %d %s", w.Code, w.Body.String())
	}
	w := runHomework(t, h, "POST", "/api/v1/homework/", parent, fields("写口算"), nil)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	// A second entry carries the media this test edits and deletes.
	w = runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", date}, {"subject", "语文"}, {"description", "抄写生字"},
	}, []homeworkFile{{name: "a.png", content: solidPNG(t, 6, 6)}})
	if w.Code != 200 {
		t.Fatalf("create with media: %d %s", w.Code, w.Body.String())
	}
	var withMedia struct {
		ID      string   `json:"id"`
		Skipped []string `json:"skipped"`
	}
	if err := json.NewDecoder(w.Body).Decode(&withMedia); err != nil {
		t.Fatal(err)
	}
	day := homeworkDay(t, h, parent, date)
	if len(day.Items) != 2 || day.Items[0].ID != created.ID || day.Items[1].ID != withMedia.ID {
		t.Fatalf("unexpected day: %+v", day.Items)
	}
	if len(day.Items[1].Media) != 1 || day.Items[1].Media[0].Name != "a.png" {
		t.Fatalf("unexpected media: %+v", day.Items[1].Media)
	}
	first := day.Items[1].Media[0].ID
	// Editing replaces one attachment with another in a single request.
	w = runHomework(t, h, "PUT", "/api/v1/homework/"+withMedia.ID, parent, [][2]string{
		{"date", date}, {"subject", "语文"}, {"description", "抄写生字两遍"}, {"remove_media", first},
	}, []homeworkFile{{name: "b.png", content: solidPNG(t, 7, 7)}})
	if w.Code != 200 {
		t.Fatalf("edit: %d %s", w.Code, w.Body.String())
	}
	day = homeworkDay(t, h, parent, date)
	if len(day.Items[1].Media) != 1 || day.Items[1].Media[0].Name != "b.png" {
		t.Fatalf("edit did not replace the media: %+v", day.Items[1].Media)
	}
	second := day.Items[1].Media[0].ID
	r := httptest.NewRequest("GET", "/api/v1/media/"+first, nil)
	r.AddCookie(parent)
	served := httptest.NewRecorder()
	h.ServeHTTP(served, r)
	if served.Code != 404 {
		t.Fatalf("removed media is still served: %d", served.Code)
	}
	// An edit may not empty the entry: no description and no surviving media.
	if w = runHomework(t, h, "PUT", "/api/v1/homework/"+withMedia.ID, parent, [][2]string{
		{"date", date}, {"subject", "语文"}, {"remove_media", second},
	}, nil); w.Code != 400 {
		t.Fatalf("emptied homework: %d %s", w.Code, w.Body.String())
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+withMedia.ID+"/media/"+second, parent, nil, nil); w.Code != 204 {
		t.Fatalf("delete media: %d %s", w.Code, w.Body.String())
	}
	if day = homeworkDay(t, h, parent, date); len(day.Items[1].Media) != 0 || day.Items[1].Description != "抄写生字两遍" {
		t.Fatalf("media survived deletion: %+v", day.Items[1])
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+withMedia.ID+"/media/"+second, parent, nil, nil); w.Code != 404 {
		t.Fatalf("re-delete media: %d %s", w.Code, w.Body.String())
	}
	// Unsupported content is skipped and reported instead of failing the batch.
	w = runHomework(t, h, "POST", "/api/v1/homework/", parent, fields("读课文"), []homeworkFile{
		{name: "notes.txt", content: []byte("plain text")},
	})
	if w.Code != 200 {
		t.Fatalf("skipped upload: %d %s", w.Code, w.Body.String())
	}
	var skipped struct {
		Skipped []string `json:"skipped"`
	}
	if err := json.NewDecoder(w.Body).Decode(&skipped); err != nil {
		t.Fatal(err)
	}
	if len(skipped.Skipped) != 1 || skipped.Skipped[0] != "notes.txt" {
		t.Fatalf("skipped=%+v, want [notes.txt]", skipped.Skipped)
	}
	// Everything below belongs to another family and must stay unreachable.
	other := otherFamily(t, s, "OTHER", "Asia/Shanghai")
	foreign := sessionFor(t, s, other, "parent", "par-other", "")
	w = runHomework(t, h, "POST", "/api/v1/homework/", foreign, fields("别人的作业"), nil)
	if w.Code != 200 {
		t.Fatalf("foreign create: %d %s", w.Code, w.Body.String())
	}
	var foreignCreated struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(w.Body).Decode(&foreignCreated); err != nil {
		t.Fatal(err)
	}
	if w = runHomework(t, h, "PUT", "/api/v1/homework/"+foreignCreated.ID, parent, fields("改别人的作业"), nil); w.Code != 404 {
		t.Fatalf("cross family edit: %d %s", w.Code, w.Body.String())
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+foreignCreated.ID, parent, nil, nil); w.Code != 404 {
		t.Fatalf("cross family delete: %d %s", w.Code, w.Body.String())
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+foreignCreated.ID+"/media/hm_missing", parent, nil, nil); w.Code != 404 {
		t.Fatalf("cross family media delete: %d %s", w.Code, w.Body.String())
	}
	// Deleting an entry cascades its media rows and removes the files.
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+created.ID, parent, nil, nil); w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if day = homeworkDay(t, h, parent, date); len(day.Items) != 2 || day.Items[0].ID == created.ID {
		t.Fatalf("deleted entry still listed: %+v", day.Items)
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+created.ID, parent, nil, nil); w.Code != 404 {
		t.Fatalf("re-delete: %d %s", w.Code, w.Body.String())
	}
	if w = runHomework(t, h, "DELETE", "/api/v1/homework/"+withMedia.ID, parent, nil, nil); w.Code != 204 {
		t.Fatalf("delete media entry: %d %s", w.Code, w.Body.String())
	}
	var stored int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM homework_media WHERE homework_id=?`, withMedia.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Fatalf("media rows survived the cascade: %d", stored)
	}
}

func TestHomeworkHolidayWindowsFollowTheOfficialCalendar(t *testing.T) {
	// 表里的日期是常量，写错一天就当场发现。
	for _, entry := range holidayTable {
		if mustDay(entry.End).Before(mustDay(entry.Start)) {
			t.Fatalf("holiday %s ends before it starts", entry.Name)
		}
	}
	// 2026 春节 2/15（周日）–2/23（周一）：周末与法定假合并成一整块。
	window, ok := holidayWindow(mustDay("2026-02-18"))
	if !ok || window.Name != "春节" || window.Start != "2026-02-15" || window.End != "2026-02-23" || window.Days != 9 || window.BeforeFrom {
		t.Fatalf("spring festival window: %+v ok=%v", window, ok)
	}
	// 2/14 是调休上班的周六，但它紧挨着假期，所以是假期作业的起点。
	window, ok = holidayWindow(mustDay("2026-02-14"))
	if !ok || window.Start != "2026-02-14" || window.End != "2026-02-23" || window.Days != 10 || !window.BeforeFrom {
		t.Fatalf("day before the spring festival: %+v ok=%v", window, ok)
	}
	// 普通周五与它后面的周末连成 3 天：周五设置等同于周末设置。
	window, ok = holidayWindow(mustDay("2026-03-06"))
	if !ok || window.Name != "周末" || window.Start != "2026-03-06" || window.End != "2026-03-08" || window.Days != 3 || !window.BeforeFrom {
		t.Fatalf("friday window: %+v ok=%v", window, ok)
	}
	// 周六自己看是 2 天，不会再往前吞掉周五。
	window, ok = holidayWindow(mustDay("2026-03-07"))
	if !ok || window.Start != "2026-03-07" || window.End != "2026-03-08" || window.Days != 2 || window.BeforeFrom {
		t.Fatalf("saturday window: %+v ok=%v", window, ok)
	}
	// 调休上班的周六不是假期，只有第二天（周日）放假时它才算假前日。
	window, ok = holidayWindow(mustDay("2026-10-10"))
	if !ok || window.Start != "2026-10-10" || window.End != "2026-10-11" || window.Days != 2 || !window.BeforeFrom {
		t.Fatalf("makeup saturday window: %+v ok=%v", window, ok)
	}
	// 2025 国庆+中秋 10/1–10/8 共 8 天，假前一天 9/30 也算进来。
	window, ok = holidayWindow(mustDay("2025-09-30"))
	if !ok || window.Name != "国庆节、中秋节" || window.Start != "2025-09-30" || window.End != "2025-10-08" || window.Days != 9 || !window.BeforeFrom {
		t.Fatalf("2025 national day window: %+v ok=%v", window, ok)
	}
	// 调休上班、前后都不放假的日子不沾假期。
	if window, ok = holidayWindow(mustDay("2026-01-04")); ok {
		t.Fatalf("makeup workday looks like a holiday: %+v", window)
	}
	// 假期结束后第一个工作日也不沾边。
	if window, ok = holidayWindow(mustDay("2026-10-09")); ok {
		t.Fatalf("day after the holiday looks like a holiday: %+v", window)
	}
}

func TestHomeworkRangeCoversEveryDayOfTheHoliday(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	parent := parentCookie(t, h)
	// 2026 国庆是 10/1–10/7，9/30 是它前一天：一条作业覆盖整段假期。
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", "2026-09-30"}, {"end_date", "2026-10-07"}, {"subject", "语文"}, {"description", "背古诗"},
	}, nil); w.Code != 200 {
		t.Fatalf("create holiday homework: %d %s", w.Code, w.Body.String())
	}
	for _, date := range []string{"2026-09-30", "2026-10-01", "2026-10-04", "2026-10-07"} {
		day := homeworkDay(t, h, parent, date)
		if len(day.Items) != 1 || day.Items[0].EndDate != "2026-10-07" || day.Items[0].Date != "2026-09-30" {
			t.Fatalf("%s: unexpected items %+v", date, day.Items)
		}
	}
	for _, date := range []string{"2026-09-29", "2026-10-08"} {
		if day := homeworkDay(t, h, parent, date); len(day.Items) != 0 {
			t.Fatalf("%s leaked %d items", date, len(day.Items))
		}
	}
	// 这天的假期信息随载荷一起回来，前端不必再问一次。
	if day := homeworkDay(t, h, parent, "2026-10-02"); day.Holiday == nil || day.Holiday.Name != "国庆节" || day.Holiday.Days != 7 {
		t.Fatalf("holiday payload: %+v", day.Holiday)
	}
	before := homeworkDay(t, h, parent, "2026-09-30")
	if before.Holiday == nil || !before.Holiday.BeforeFrom || before.Holiday.Start != "2026-09-30" || before.Holiday.Days != 8 {
		t.Fatalf("day before the holiday: %+v", before.Holiday)
	}
	// 日历需要的整张表随 /state 下发：官方区间 + 调休上班日。
	if st := getStateTest(t, h, parent); len(st.Holidays) == 0 || len(st.MakeupWorkdays) == 0 || st.Holidays[0].Name == "" {
		t.Fatalf("state calendar data: %+v %v", st.Holidays, st.MakeupWorkdays)
	}
	// 不给 end_date 就是单日作业，第二天读不到它。
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", "2026-10-03"}, {"subject", "数学"}, {"description", "口算一页"},
	}, nil); w.Code != 200 {
		t.Fatalf("create single day: %d %s", w.Code, w.Body.String())
	}
	if day := homeworkDay(t, h, parent, "2026-10-03"); len(day.Items) != 2 || day.Items[1].EndDate != "2026-10-03" {
		t.Fatalf("single day entry: %+v", day.Items)
	}
	if day := homeworkDay(t, h, parent, "2026-10-04"); len(day.Items) != 1 {
		t.Fatalf("single day entry leaked to the next day: %+v", day.Items)
	}
	// 三处校验：早于开始、超长、日期格式。
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", "2026-09-30"}, {"end_date", "2026-09-29"}, {"subject", "语文"}, {"description", "背古诗"},
	}, nil); w.Code != 400 {
		t.Fatalf("end before start: %d %s", w.Code, w.Body.String())
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", "2026-09-01"}, {"end_date", "2026-09-22"}, {"subject", "语文"}, {"description", "背古诗"},
	}, nil); w.Code != 400 {
		t.Fatalf("range too long: %d %s", w.Code, w.Body.String())
	}
	if w := runHomework(t, h, "POST", "/api/v1/homework/", parent, [][2]string{
		{"date", "2026-09-01"}, {"end_date", "2026-9-2"}, {"subject", "语文"}, {"description", "背古诗"},
	}, nil); w.Code != 400 {
		t.Fatalf("bad end date: %d %s", w.Code, w.Body.String())
	}
	// 区间读也是家庭作用域内的。
	foreign := sessionFor(t, s, otherFamily(t, s, "OTHER2", "Asia/Shanghai"), "parent", "par-other2", "")
	if other := homeworkDay(t, h, foreign, "2026-10-02"); len(other.Items) != 0 {
		t.Fatalf("other family sees %d items", len(other.Items))
	}
}
