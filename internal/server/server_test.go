package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(Config{DBPath: filepath.Join(dir, "test.db"), MediaDir: filepath.Join(dir, "media")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err = s.CreateFamily(context.Background(), FamilyInput{Code: "DEMO", Name: "Demo", Username: "parent", Password: "growjoy2468"}); err != nil {
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
	w := doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"FamilyCode": "DEMO", "Username": "parent", "Password": "growjoy2468"}, nil, "")
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	return w.Result().Cookies()[0]
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

func multipartRequest(t *testing.T, path string, cookie *http.Cookie, key string, files map[string][]byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
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
	r := httptest.NewRequest(http.MethodPost, path, &body)
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
	legacy, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := migrationFS.ReadFile("migrations/001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = legacy.Exec(string(migration)); err == nil {
		_, err = legacy.Exec(`INSERT INTO families(id,code,name,timezone,created_at) VALUES('family-legacy','LEGACY','Legacy','Asia/Shanghai','2025-01-01T00:00:00Z')`)
	}
	if err == nil {
		_, err = legacy.Exec(`INSERT INTO children(id,family_id,name,avatar,color,pin_hash,level,experience,created_at) VALUES('child-legacy','family-legacy','Legacy child','x','#000','hash',4,72,'2025-01-01T00:00:00Z')`)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err = legacy.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	var before int
	if err = s.db.QueryRow(`SELECT experience FROM children WHERE id='child-legacy'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != 372 {
		t.Fatalf("migrated experience=%d, want 372", before)
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
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/parent", bytes.NewBufferString(`{"familyCode":"DEMO","username":"parent","password":"growjoy2468"}`))
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
	if err := s.CreateFamily(context.Background(), FamilyInput{Code: "PACIFIC", Name: "Pacific", Timezone: "America/Los_Angeles", Username: "parent", Password: "anotherpass"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemo(context.Background(), "PACIFIC"); err != nil {
		t.Fatal(err)
	}
	var family, child string
	if err := s.db.QueryRow(`SELECT id FROM families WHERE code='PACIFIC'`).Scan(&family); err != nil {
		t.Fatal(err)
	}
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
	if err := s.db.QueryRow(`SELECT due_date FROM task_instances WHERE family_id=? AND repeat_rule='daily' LIMIT 1`, family).Scan(&seededDue); err != nil {
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
	login := doJSON(t, h, http.MethodPost, "/api/v1/auth/child", map[string]string{"familyCode": "DEMO", "childId": task.ChildID, "pin": "2468"}, nil, "")
	if login.Code != http.StatusOK {
		t.Fatalf("child login: %s", login.Body.String())
	}
	child := login.Result().Cookies()[0]

	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, multipartRequest(t, "/api/v1/tasks/"+task.ID+"/submit", child, "bad-upload", map[string][]byte{"fake.jpg": []byte("plain text")}))
	if bad.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("fake image status=%d, want 415", bad.Code)
	}

	var wg sync.WaitGroup
	codes := make(chan int, 2)
	requests := map[string]*http.Request{}
	for _, key := range []string{"concurrent-a", "concurrent-b"} {
		requests[key] = multipartRequest(t, "/api/v1/tasks/"+task.ID+"/submit", child, key, nil)
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
	childLogin := doJSON(t, h, "POST", "/api/v1/auth/child", map[string]string{"FamilyCode": "DEMO", "ChildID": pending.ChildID, "PIN": "2468"}, nil, "")
	if childLogin.Code != 200 {
		t.Fatalf("child login: %s", childLogin.Body.String())
	}
	childCookie := childLogin.Result().Cookies()[0]
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

func TestFamilyIsolationAndLastChildProtection(t *testing.T) {
	s := testServer(t)
	if err := s.CreateFamily(context.Background(), FamilyInput{Code: "OTHER", Name: "Other", Username: "parent", Password: "anotherpass"}); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	cookie := parentCookie(t, h)
	state := getStateTest(t, h, cookie)
	if len(state.Children) != 2 {
		t.Fatalf("children=%d", len(state.Children))
	}
	for len(state.Children) > 1 {
		w := doJSON(t, h, "DELETE", "/api/v1/children/"+state.Children[len(state.Children)-1].ID, nil, cookie, "")
		if w.Code != 204 {
			t.Fatalf("delete: %d %s", w.Code, w.Body.String())
		}
		state = getStateTest(t, h, cookie)
	}
	w := doJSON(t, h, "DELETE", "/api/v1/children/"+state.Children[0].ID, nil, cookie, "")
	if w.Code != 409 {
		t.Fatalf("last child status=%d", w.Code)
	}
	other := doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"FamilyCode": "OTHER", "Username": "parent", "Password": "anotherpass"}, nil, "")
	if other.Code != 200 {
		t.Fatalf("other login: %s", other.Body.String())
	}
	otherState := getStateTest(t, h, other.Result().Cookies()[0])
	if len(otherState.Children) != 0 || len(otherState.Tasks) != 0 {
		t.Fatal("family data leaked")
	}
}

func TestAuthFailureBudgetThrottlesGuessingWithoutLockingOutTheFamily(t *testing.T) {
	s := testServer(t)
	if err := s.CreateFamily(context.Background(), FamilyInput{Code: "PACIFIC", Name: "Pacific", Username: "parent", Password: "anotherpass"}); err != nil {
		t.Fatal(err)
	}
	var childID string
	if err := s.db.QueryRow(`SELECT id FROM children WHERE family_id=(SELECT id FROM families WHERE code='DEMO') ORDER BY created_at LIMIT 1`).Scan(&childID); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	attempt := func(code, id, pin string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/auth/child", map[string]string{"FamilyCode": code, "ChildID": id, "PIN": pin}, nil, "")
	}
	guesses := 0
	for range authFailBurst + 5 {
		w := attempt("DEMO", childID, "0000")
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
	w := attempt("DEMO", childID, "0000")
	if w.Code != 429 || !strings.Contains(w.Body.String(), "too_many_requests") {
		t.Fatalf("throttled response: %d %s", w.Code, w.Body.String())
	}
	// The correct PIN is never charged, so guessing cannot lock a family out.
	if ok := attempt("DEMO", childID, "2468"); ok.Code != 200 {
		t.Fatalf("correct PIN blocked by the failure budget: %d %s", ok.Code, ok.Body.String())
	}
	// Budgets are per actor and per family: a child's typos must not lock the
	// parent out, and one family must not throttle another.
	wrongParent := func(code string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/auth/parent", map[string]string{"FamilyCode": code, "Username": "parent", "Password": "wrongpass"}, nil, "")
	}
	if w := wrongParent("DEMO"); w.Code != 401 {
		t.Fatalf("child and parent share a failure budget: %d %s", w.Code, w.Body.String())
	}
	if w := wrongParent("PACIFIC"); w.Code != 401 {
		t.Fatalf("failure budget leaked across families: %d %s", w.Code, w.Body.String())
	}
}

func TestSaturatedHashGateShedsLoad(t *testing.T) {
	s := testServer(t)
	for range argon2Slots {
		s.hashGate <- struct{}{}
	}
	r := httptest.NewRequest("POST", "/api/v1/auth/parent", strings.NewReader(`{"FamilyCode":"DEMO","Username":"parent","Password":"growjoy2468"}`))
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
