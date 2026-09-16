package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

const cookieName = "growjoy_session"

type Config struct {
	DBPath, MediaDir, DistDir string
	SecureCookies             bool
}
type Server struct {
	db                *sql.DB
	mediaDir, distDir string
	secureCookies     bool
	log               *slog.Logger
	now               func() time.Time
	authIP            *limiter
	authFailures      *limiter
	hashGate          chan struct{}
}
type session struct{ ID, FamilyID, ActorType, ActorID, SelectedChildID string }
type ctxKey struct{}

type Child struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Avatar        string  `json:"avatar"`
	Color         string  `json:"color"`
	Level         int     `json:"level"`
	Experience    float64 `json:"experience"`
	PointsBalance int     `json:"pointsBalance"`
	StreakDays    int     `json:"streakDays"`
}
type Task struct {
	ID            string `json:"id"`
	ChildID       string `json:"childId"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	Points        int    `json:"points"`
	RepeatRule    string `json:"repeatRule"`
	RepeatWeekday int    `json:"repeatWeekday"`
	DueDate       string `json:"dueDate"`
	Status        string `json:"status"`
	CreatedAt     string `json:"createdAt"`
}
type Attachment struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Type string `json:"type"`
	URL  string `json:"url,omitempty"`
}
type Submission struct {
	ID          string       `json:"id"`
	TaskID      string       `json:"taskId"`
	ChildID     string       `json:"childId"`
	Note        string       `json:"note"`
	Attachments []Attachment `json:"attachments"`
	SubmittedAt string       `json:"submittedAt"`
	ReviewedAt  *string      `json:"reviewedAt,omitempty"`
	ReviewNote  *string      `json:"reviewNote,omitempty"`
}
type Wish struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	PointsCost  int    `json:"pointsCost"`
	Icon        string `json:"icon"`
	Color       string `json:"color"`
	IsActive    bool   `json:"isActive"`
}
type Ledger struct {
	ID          string `json:"id"`
	ChildID     string `json:"childId"`
	Amount      int    `json:"amount"`
	Type        string `json:"type"`
	ReferenceID string `json:"referenceId"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
}
type Redemption struct {
	ID            string       `json:"id"`
	WishID        string       `json:"wishId"`
	WishTitle     string       `json:"wishTitle"`
	WishIcon      string       `json:"wishIcon"`
	WishColor     string       `json:"wishColor"`
	ChildID       string       `json:"childId"`
	PointsCost    int          `json:"pointsCost"`
	CompletedAt   *string      `json:"completedAt,omitempty"`
	CompletedNote string       `json:"completedNote,omitempty"`
	Attachments   []Attachment `json:"attachments"`
	CreatedAt     string       `json:"createdAt"`
}
type State struct {
	Version       int          `json:"version"`
	Timezone      string       `json:"timezone"`
	Role          string       `json:"role"`
	ActiveChildID string       `json:"activeChildId"`
	Children      []Child      `json:"children"`
	Tasks         []Task       `json:"tasks"`
	Submissions   []Submission `json:"submissions"`
	Wishes        []Wish       `json:"wishes"`
	Ledger        []Ledger     `json:"ledger"`
	Redemptions   []Redemption `json:"redemptions"`
}

func Open(cfg Config, logger *slog.Logger) (*Server, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.DBPath == "" {
		cfg.DBPath = "data/growjoy.db"
	}
	if cfg.MediaDir == "" {
		cfg.MediaDir = "data/media"
	}
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.MediaDir, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000"} {
		if _, err = db.Exec(pragma); err != nil {
			db.Close()
			return nil, err
		}
	}
	if err = applyMigrations(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Server{
		db:            db,
		mediaDir:      cfg.MediaDir,
		distDir:       cfg.DistDir,
		secureCookies: cfg.SecureCookies,
		log:           logger,
		now:           time.Now,
		authIP:        newLimiter(authIPBurst, authIPRefill),
		authFailures:  newLimiter(authFailBurst, authFailRefill),
		hashGate:      make(chan struct{}, argon2Slots),
	}, nil
}

func applyMigrations(db *sql.DB) error {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("invalid migration name %q: %w", entry.Name(), err)
		}
		migration, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		if version == 1 {
			if _, err = db.Exec(string(migration)); err != nil {
				return fmt.Errorf("migration %d: %w", version, err)
			}
			continue
		}
		var applied int
		if err = db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version=?`, version).Scan(&applied); err != nil {
			return err
		}
		if applied != 0 {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err = tx.Exec(string(migration)); err == nil {
			_, err = tx.Exec(`INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)`, version, nowText(time.Now()))
		}
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d: %w", version, err)
		}
		if err = tx.Commit(); err != nil {
			return fmt.Errorf("migration %d commit: %w", version, err)
		}
	}
	return nil
}
func (s *Server) Close() error { return s.db.Close() }
func (s *Server) DB() *sql.DB  { return s.db }

// idempotencyRetention bounds how long a completed mutation can be replayed.
// It matches the longest session lifetime: older keys cannot belong to a live
// client, so keeping them only grows the database.
const idempotencyRetention = 30 * 24 * time.Hour

// Sweep reclaims expired sessions and stale idempotency keys. Expired sessions
// are otherwise deleted only when a client logs out or switches profile, so a
// long-lived database would grow without bound.
func (s *Server) Sweep(ctx context.Context) error {
	now := s.now()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, nowText(now)); err != nil {
		return fmt.Errorf("sweep sessions: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM idempotency_keys WHERE created_at < ?`, nowText(now.Add(-idempotencyRetention))); err != nil {
		return fmt.Errorf("sweep idempotency keys: %w", err)
	}
	s.authIP.evict(now, bucketIdle)
	s.authFailures.evict(now, bucketIdle)
	return nil
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Get("/health/live", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	r.Get("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := s.db.PingContext(r.Context()); err != nil {
			s.log.Error("readiness check failed", "err", err.Error())
			problem(w, 503, "unavailable", "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	r.Route("/api/v1", func(api chi.Router) {
		api.Use(sameOrigin)
		api.Group(func(auth chi.Router) {
			auth.Use(s.authLimit)
			auth.Post("/auth/child", s.childSession)
			auth.Post("/auth/parent", s.parentSession)
		})
		api.Group(func(a chi.Router) {
			a.Use(s.authenticate)
			a.Get("/state", s.getState)
			a.Patch("/session/child", s.selectChild)
			// 当前密码错误时这条路径回 401，所以它必须留在 /auth/ 前缀下：src/store.ts 的
			// request() 对非 /auth/ 路径的 401 会先重开孩子端再重放一次，打错一次当前密码就会
			// 把家长会话降级成孩子会话。
			a.Post("/auth/parent/password", s.parentOnly(s.changeParentPassword))
			a.Route("/children", func(c chi.Router) {
				c.Post("/", s.parentOnly(s.saveChild))
				c.Put("/{id}", s.parentOnly(s.saveChild))
				c.Delete("/{id}", s.parentOnly(s.deleteChild))
			})
			a.Route("/tasks", func(t chi.Router) {
				t.Post("/", s.parentOnly(s.saveTask))
				t.Put("/{id}", s.parentOnly(s.saveTask))
				t.Delete("/{id}", s.parentOnly(s.deleteTask))
				t.Post("/{id}/submit", s.submitTask)
				t.Post("/{id}/review", s.parentOnly(s.reviewTask))
			})
			a.Route("/wishes", func(v chi.Router) {
				v.Post("/", s.parentOnly(s.saveWish))
				v.Put("/{id}", s.parentOnly(s.saveWish))
				v.Delete("/{id}", s.parentOnly(s.deleteWish))
				v.Post("/{id}/redeem", s.redeemWish)
			})
			a.Patch("/redemptions/{id}", s.completeRedemption)
			a.Get("/media/{id}", s.media)
			a.Get("/stats", s.stats)
		})
	})
	if s.distDir != "" {
		r.Handle("/*", spaHandler(s.distDir))
	}
	return requestLog(s.log, recoverPanic(s.log, r))
}

func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
			problem(w, http.StatusForbidden, "cross_site_request", "cross-site requests are not allowed")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			parsed, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(parsed.Host, r.Host) {
				problem(w, http.StatusForbidden, "origin_mismatch", "request origin does not match host")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func requestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Info("http", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	d.DisallowUnknownFields()
	return d.Decode(v)
}
func id(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}
func nowText(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func hashSecret(value string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey([]byte(value), salt, 1, 64*1024, 4, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=1,p=4$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(sum)), nil
}
func verifySecret(encoded, value string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var mem uint32
	var tm uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &tm, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(value), salt, tm, mem, threads, uint32(len(want)))
	return subtleEqual(got, want)
}
func subtleEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
func tokenHash(raw string) string { h := sha256.Sum256([]byte(raw)); return hex.EncodeToString(h[:]) }

func (s *Server) createSession(w http.ResponseWriter, family, typ, actor, child string, duration time.Duration) error {
	rawBytes := make([]byte, 32)
	if _, err := rand.Read(rawBytes); err != nil {
		return err
	}
	raw := base64.RawURLEncoding.EncodeToString(rawBytes)
	expires := s.now().Add(duration)
	_, err := s.db.Exec(`INSERT INTO sessions(id,token_hash,family_id,actor_type,actor_id,selected_child_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)`, id("ses"), tokenHash(raw), family, typ, actor, nullString(child), nowText(expires), nowText(s.now()))
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: raw, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: s.secureCookies, Expires: expires})
	return nil
}
func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// validPin reports whether value is exactly four decimal digits: the format
// every parent credential is set with. Sign-in does not check it, so rows
// written before this rule keep working.
func validPin(value string) bool {
	if len(value) != 4 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
// lookupSession resolves the session cookie without failing the request: the
// child end is open to the household, so a missing or expired cookie is a
// normal state rather than an error.
func (s *Server) lookupSession(r *http.Request) (session, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return session{}, false
	}
	var x session
	err = s.db.QueryRow(`SELECT id,family_id,actor_type,actor_id,COALESCE(selected_child_id,'') FROM sessions WHERE token_hash=? AND expires_at>?`, tokenHash(c.Value), nowText(s.now())).Scan(&x.ID, &x.FamilyID, &x.ActorType, &x.ActorID, &x.SelectedChildID)
	if err != nil {
		return session{}, false
	}
	return x, true
}
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		x, ok := s.lookupSession(r)
		if !ok {
			problem(w, 401, "unauthorized", "session required")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, x)))
	})
}
func sess(r *http.Request) session { return r.Context().Value(ctxKey{}).(session) }
func (s *Server) parentOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sess(r).ActorType != "parent" {
			problem(w, 403, "forbidden", "parent access required")
			return
		}
		h(w, r)
	}
}

// childSession is the default child end: it starts a child session whenever
// the caller has none and demotes a parent session, so the app always boots
// into the child end and switching to the parent end always costs the
// password again.
func (s *Server) childSession(w http.ResponseWriter, r *http.Request) {
	current, had := s.lookupSession(r)
	if had && current.ActorType == "child" {
		writeJSON(w, 200, map[string]string{"role": "child", "activeChildId": current.SelectedChildID})
		return
	}
	family, _, err := s.resolvedFamily(r.Context())
	if err != nil {
		s.familyError(w, r, err)
		return
	}
	child := s.firstChild(r.Context(), family)
	if had {
		// A demoted parent keeps the child it was looking at, and its spent
		// session row is dropped rather than left to expire.
		if kept := s.familyChild(r.Context(), family, current.SelectedChildID); kept != "" {
			child = kept
		}
		_, _ = s.db.Exec(`DELETE FROM sessions WHERE id=? AND family_id=?`, current.ID, family)
	}
	if err = s.createSession(w, family, "child", child, child, 30*24*time.Hour); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"role": "child", "activeChildId": child})
}

// parentSession unlocks the management end; the family's parent password is
// the only credential in the app.
func (s *Server) parentSession(w http.ResponseWriter, r *http.Request) {
	var in struct{ Password string }
	if decode(r, &in) != nil {
		problem(w, 400, "invalid_request", "invalid JSON")
		return
	}
	family, code, err := s.resolvedFamily(r.Context())
	if err != nil {
		s.familyError(w, r, err)
		return
	}
	current, _ := s.lookupSession(r)
	parents, err := s.parentSecrets(r.Context(), family)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	parent := ""
	for _, candidate := range parents {
		ok, verr := s.verifyPassword(r.Context(), candidate.hash, in.Password)
		if verr != nil {
			s.hashFailure(w, r, verr)
			return
		}
		if ok {
			parent = candidate.id
			break
		}
	}
	if parent == "" {
		// Only a wrong password charges the budget, so a guess cannot lock the
		// family out of its own parent end.
		budget := authFailureKey(code, "parent")
		if !s.authBudgetLeft(budget) {
			problem(w, 429, "too_many_requests", "too many requests; try again later")
			return
		}
		s.recordAuthFailure(budget)
		problem(w, 401, "invalid_credentials", "credentials are invalid")
		return
	}
	child := s.familyChild(r.Context(), family, current.SelectedChildID)
	if child == "" {
		child = s.firstChild(r.Context(), family)
	}
	if current.ID != "" {
		if _, err = s.db.Exec(`DELETE FROM sessions WHERE id=? AND family_id=?`, current.ID, family); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if err = s.createSession(w, family, "parent", parent, child, 12*time.Hour); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"role": "parent", "activeChildId": child})
}

// resolvedFamily names the family this deployment serves. GrowJoy is a
// single-family household app, so the oldest family row wins and no screen
// ever asks for a family code.
func (s *Server) resolvedFamily(ctx context.Context) (string, string, error) {
	var family, code string
	err := s.db.QueryRowContext(ctx, `SELECT id,code FROM families ORDER BY created_at,id LIMIT 1`).Scan(&family, &code)
	return family, code, err
}

// familyError answers the one startup state the UI can hit: no family at all.
func (s *Server) familyError(w http.ResponseWriter, r *http.Request, err error) {
	if err == sql.ErrNoRows {
		problem(w, 409, "no_family", "no family is set up yet")
		return
	}
	s.internalError(w, r, err)
}

// firstChild is the family's oldest child, or "" while the family has none.
func (s *Server) firstChild(ctx context.Context, family string) string {
	var child string
	_ = s.db.QueryRowContext(ctx, `SELECT id FROM children WHERE family_id=? ORDER BY created_at,id LIMIT 1`, family).Scan(&child)
	return child
}

// familyChild returns child when it belongs to family, else "".
func (s *Server) familyChild(ctx context.Context, family, child string) string {
	if child == "" {
		return ""
	}
	var found int
	if s.db.QueryRowContext(ctx, `SELECT 1 FROM children WHERE id=? AND family_id=?`, child, family).Scan(&found) != nil {
		return ""
	}
	return child
}

type parentSecret struct{ id, hash string }

// parentSecrets lists the family's parents: the password belongs to the
// family, so every parent row gets a chance to match it.
func (s *Server) parentSecrets(ctx context.Context, family string) ([]parentSecret, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,password_hash FROM parents WHERE family_id=? ORDER BY created_at,id`, family)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []parentSecret
	for rows.Next() {
		var p parentSecret
		if err = rows.Scan(&p.id, &p.hash); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// selectChild switches the profile the device is showing. The child end may
// switch as well: one household device is shared by siblings. A child session
// mirrors the profile in actor_id, so the child-scoped statements and the
// per-child idempotency keys stay exact.
func (s *Server) selectChild(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	var in struct {
		ChildID string `json:"childId"`
	}
	if decode(r, &in) != nil {
		problem(w, 400, "invalid_request", "invalid JSON")
		return
	}
	res, err := s.db.Exec(`UPDATE sessions SET selected_child_id=?, actor_id=CASE WHEN actor_type='child' THEN ? ELSE actor_id END WHERE id=? AND family_id=? AND EXISTS(SELECT 1 FROM children WHERE id=? AND family_id=?)`, in.ChildID, in.ChildID, x.ID, x.FamilyID, in.ChildID, x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		problem(w, 404, "not_found", "child not found")
		return
	}
	w.WriteHeader(204)
}

// changeParentPassword replaces the family's parent credential. The password
// belongs to the family (parentSecrets tries every row), so every parent row
// is rewritten. Sessions are deliberately left alone.
func (s *Server) changeParentPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if decode(r, &in) != nil {
		problem(w, 400, "invalid_request", "invalid JSON")
		return
	}
	if !validPin(in.NewPassword) {
		problem(w, 400, "invalid_request", "new password must be exactly 4 digits")
		return
	}
	family, code, err := s.resolvedFamily(r.Context())
	if err != nil {
		s.familyError(w, r, err)
		return
	}
	parents, err := s.parentSecrets(r.Context(), family)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	matched := false
	for _, candidate := range parents {
		ok, verr := s.verifyPassword(r.Context(), candidate.hash, in.CurrentPassword)
		if verr != nil {
			s.hashFailure(w, r, verr)
			return
		}
		if ok {
			matched = true
			break
		}
	}
	if !matched {
		// 与 /auth/parent 共用同一个桶：猜错一次就消耗一次额度，两个入口不会
		// 变相把攻击者的尝试次数翻倍；正确密码永不消耗，家庭不会被锁在门外。
		budget := authFailureKey(code, "parent")
		if !s.authBudgetLeft(budget) {
			problem(w, 429, "too_many_requests", "too many requests; try again later")
			return
		}
		s.recordAuthFailure(budget)
		problem(w, 401, "invalid_credentials", "credentials are invalid")
		return
	}
	hash, err := s.hashPassword(r.Context(), in.NewPassword)
	if err != nil {
		s.hashFailure(w, r, err)
		return
	}
	if _, err = s.db.ExecContext(r.Context(), `UPDATE parents SET password_hash=? WHERE family_id=?`, hash, family); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) familyLocation(ctx context.Context, family string) (*time.Location, error) {
	var timezone string
	if err := s.db.QueryRowContext(ctx, `SELECT timezone FROM families WHERE id=?`, family).Scan(&timezone); err != nil {
		return nil, err
	}
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, fmt.Errorf("load family timezone %q: %w", timezone, err)
	}
	return loc, nil
}

func (s *Server) ensureInstances(ctx context.Context, family string) error {
	loc, err := s.familyLocation(ctx, family)
	if err != nil {
		return err
	}
	now := s.now().In(loc)
	date := now.Format("2006-01-02")
	mondayOffset := (int(now.Weekday()) + 6) % 7
	monday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -mondayOffset)
	week := monday.Format("2006-01-02")
	rows, err := s.db.QueryContext(ctx, `SELECT id,child_id,title,description,category,points,repeat_rule,repeat_weekday,created_at FROM task_templates WHERE family_id=? AND active=1`, family)
	if err != nil {
		return err
	}
	type template struct {
		tid, cid, title, desc, cat, rule, created string
		points, weekday                           int
	}
	var templates []template
	for rows.Next() {
		var v template
		if err = rows.Scan(&v.tid, &v.cid, &v.title, &v.desc, &v.cat, &v.points, &v.rule, &v.weekday, &v.created); err != nil {
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
	for _, v := range templates {
		key, due := "once", date
		if v.rule == "daily" {
			key = date
		} else if v.rule == "weekly" {
			key = week
			weekdayOffset := (v.weekday + 6) % 7
			due = monday.AddDate(0, 0, weekdayOffset).Format("2006-01-02")
		}
		if v.rule == "once" {
			created, parseErr := time.Parse(time.RFC3339Nano, v.created)
			if parseErr != nil {
				return fmt.Errorf("parse task template creation time: %w", parseErr)
			}
			due = created.In(loc).Format("2006-01-02")
		}
		_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_instances(id,family_id,template_id,child_id,period_key,title,description,category,points,repeat_rule,repeat_weekday,due_date,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("task"), family, v.tid, v.cid, key, v.title, v.desc, v.cat, v.points, v.rule, v.weekday, due, "todo", nowText(s.now()))
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) streaks(ctx context.Context, family string, loc *time.Location) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT child_id,created_at FROM point_ledger WHERE family_id=? AND entry_type='earned' ORDER BY created_at DESC`, family)
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
	out.Version = 2
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
		var totalExperience int
		if err = rows.Scan(&c.ID, &c.Name, &c.Avatar, &c.Color, &totalExperience, &c.PointsBalance); err != nil {
			rows.Close()
			return out, err
		}
		c.Level = 1 + totalExperience/100
		c.Experience = float64(totalExperience % 100)
		c.StreakDays = streaks[c.ID]
		out.Children = append(out.Children, c)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,child_id,title,description,category,points,repeat_rule,repeat_weekday,due_date,status,created_at FROM task_instances WHERE family_id=? AND template_id IS NOT NULL AND (?='parent' OR child_id=?) ORDER BY created_at DESC`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Task
		if err = rows.Scan(&v.ID, &v.ChildID, &v.Title, &v.Description, &v.Category, &v.Points, &v.RepeatRule, &v.RepeatWeekday, &v.DueDate, &v.Status, &v.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
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
	rows, err = s.db.QueryContext(ctx, `SELECT id,child_id,amount,entry_type,reference_id,description,created_at FROM point_ledger WHERE family_id=? AND (?='parent' OR child_id=?) ORDER BY created_at`, x.FamilyID, x.ActorType, x.SelectedChildID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Ledger
		if err = rows.Scan(&v.ID, &v.ChildID, &v.Amount, &v.Type, &v.ReferenceID, &v.Description, &v.CreatedAt); err != nil {
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

type childInput struct {
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
	Color  string `json:"color"`
}

func (s *Server) saveChild(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	var in childInput
	if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" || in.Avatar == "" {
		problem(w, 400, "invalid_request", "name and avatar are required")
		return
	}
	cid := chi.URLParam(r, "id")
	if cid == "" {
		cid = id("child")
		_, err := s.db.Exec(`INSERT INTO children(id,family_id,name,avatar,color,created_at) VALUES(?,?,?,?,?,?)`, cid, x.FamilyID, strings.TrimSpace(in.Name), in.Avatar, in.Color, nowText(s.now()))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		_, _ = s.db.Exec(`UPDATE sessions SET selected_child_id=? WHERE id=?`, cid, x.ID)
	} else {
		res, err := s.db.Exec(`UPDATE children SET name=?,avatar=?,color=? WHERE id=? AND family_id=?`, strings.TrimSpace(in.Name), in.Avatar, in.Color, cid, x.FamilyID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			problem(w, 404, "not_found", "child not found")
			return
		}
	}
	writeJSON(w, 200, map[string]string{"id": cid})
}
func (s *Server) deleteChild(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	cid := chi.URLParam(r, "id")
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM children WHERE family_id=?`, x.FamilyID).Scan(&count)
	if count <= 1 {
		problem(w, 409, "last_child", "at least one child is required")
		return
	}
	mediaFiles := s.mediaForChild(r.Context(), x.FamilyID, cid)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var replacement string
	if err = tx.QueryRow(`SELECT id FROM children WHERE family_id=? AND id<>? ORDER BY created_at LIMIT 1`, x.FamilyID, cid).Scan(&replacement); err != nil {
		problem(w, 409, "last_child", "at least one child is required")
		return
	}
	if _, err = tx.Exec(`DELETE FROM sessions WHERE family_id=? AND actor_type='child' AND actor_id=?`, x.FamilyID, cid); err == nil {
		_, err = tx.Exec(`UPDATE sessions SET selected_child_id=? WHERE family_id=? AND selected_child_id=?`, replacement, x.FamilyID, cid)
	}
	var res sql.Result
	if err == nil {
		res, err = tx.Exec(`DELETE FROM children WHERE id=? AND family_id=?`, cid, x.FamilyID)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		problem(w, 404, "not_found", "child not found")
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, name := range mediaFiles {
		_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(name)))
	}
	w.WriteHeader(204)
}

func (s *Server) mediaForChild(ctx context.Context, family, child string) []string {
	rows, err := s.db.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN task_submissions s ON s.id=a.submission_id WHERE a.family_id=? AND s.child_id=?`, family, child)
	var out []string
	if err == nil {
		for rows.Next() {
			var name string
			if rows.Scan(&name) == nil {
				out = append(out, name)
			}
		}
		rows.Close()
	}
	rows, err = s.db.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN redemptions r ON r.id=a.redemption_id WHERE a.family_id=? AND r.child_id=?`, family, child)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			out = append(out, name)
		}
	}
	return out
}

func (s *Server) mediaForTemplate(ctx context.Context, family, template string) []string {
	rows, err := s.db.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN task_submissions s ON s.id=a.submission_id JOIN task_instances i ON i.id=s.task_instance_id WHERE a.family_id=? AND i.template_id=?`, family, template)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			out = append(out, name)
		}
	}
	return out
}

type taskInput struct {
	ChildID       string `json:"childId"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	Points        int    `json:"points"`
	RepeatRule    string `json:"repeatRule"`
	RepeatWeekday int    `json:"repeatWeekday"`
}

func (s *Server) saveTask(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	var in taskInput
	if decode(r, &in) != nil || strings.TrimSpace(in.Title) == "" || in.Points < 1 {
		problem(w, 400, "invalid_request", "valid title and points required")
		return
	}
	if in.RepeatRule != "once" && in.RepeatRule != "daily" && in.RepeatRule != "weekly" {
		problem(w, 400, "invalid_request", "invalid repeatRule")
		return
	}
	if in.RepeatWeekday < 0 || in.RepeatWeekday > 6 {
		problem(w, 400, "invalid_request", "repeatWeekday must be between 0 and 6")
		return
	}
	var childExists int
	if s.db.QueryRow(`SELECT 1 FROM children WHERE id=? AND family_id=?`, in.ChildID, x.FamilyID).Scan(&childExists) != nil {
		problem(w, 404, "not_found", "child not found")
		return
	}
	instance := chi.URLParam(r, "id")
	now := nowText(s.now())
	if instance == "" {
		tid := id("tpl")
		_, err := s.db.Exec(`INSERT INTO task_templates(id,family_id,child_id,title,description,category,points,repeat_rule,repeat_weekday,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, tid, x.FamilyID, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, in.RepeatWeekday, now, now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		_ = s.ensureInstances(r.Context(), x.FamilyID)
		_ = s.db.QueryRow(`SELECT id FROM task_instances WHERE template_id=? ORDER BY created_at DESC LIMIT 1`, tid).Scan(&instance)
	} else {
		res, err := s.db.Exec(`UPDATE task_templates SET child_id=?,title=?,description=?,category=?,points=?,repeat_rule=?,repeat_weekday=?,updated_at=? WHERE family_id=? AND id=(SELECT template_id FROM task_instances WHERE id=? AND family_id=?)`, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, in.RepeatWeekday, now, x.FamilyID, instance, x.FamilyID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			problem(w, 404, "not_found", "task not found")
			return
		}
		_, _ = s.db.Exec(`UPDATE task_instances SET child_id=?,title=?,description=?,category=?,points=?,repeat_rule=?,repeat_weekday=? WHERE id=? AND family_id=? AND status IN ('todo','rejected') AND NOT EXISTS(SELECT 1 FROM task_submissions WHERE task_instance_id=task_instances.id)`, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, in.RepeatWeekday, instance, x.FamilyID)
	}
	writeJSON(w, 200, map[string]string{"id": instance})
}
func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	iid := chi.URLParam(r, "id")
	var templateID string
	if err := s.db.QueryRow(`SELECT template_id FROM task_instances WHERE id=? AND family_id=? AND template_id IS NOT NULL`, iid, x.FamilyID).Scan(&templateID); err != nil {
		problem(w, 404, "not_found", "task not found")
		return
	}
	files := s.mediaForTemplate(r.Context(), x.FamilyID, templateID)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE task_templates SET active=0 WHERE family_id=? AND id=? AND active=1`, x.FamilyID, templateID)
	if err == nil {
		_, err = tx.Exec(`DELETE FROM task_instances WHERE family_id=? AND template_id=?`, x.FamilyID, templateID)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		problem(w, 404, "not_found", "task not found")
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, name := range files {
		_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(name)))
	}
	w.WriteHeader(204)
}

func inspectUpload(h *multipart.FileHeader) (kind, mimeType, extension string, ok bool) {
	if h.Size <= 0 {
		return "", "", "", false
	}
	file, err := h.Open()
	if err != nil {
		return "", "", "", false
	}
	defer file.Close()
	header := make([]byte, 512)
	n, err := io.ReadFull(file, header)
	if err != nil && err != io.ErrUnexpectedEOF {
		return "", "", "", false
	}
	mimeType = http.DetectContentType(header[:n])
	if mimeType == "application/octet-stream" {
		if isMP4(header[:n], h.Size) {
			mimeType = "video/mp4"
		} else if isWebM(header[:n]) {
			mimeType = "video/webm"
		}
	}
	switch mimeType {
	case "image/jpeg":
		return "image", mimeType, ".jpg", h.Size <= 10<<20
	case "image/png":
		return "image", mimeType, ".png", h.Size <= 10<<20
	case "image/webp":
		return "image", mimeType, ".webp", h.Size <= 10<<20
	case "video/mp4":
		return "video", mimeType, ".mp4", h.Size <= 100<<20
	case "video/webm":
		return "video", mimeType, ".webm", h.Size <= 100<<20
	default:
		return "", "", "", false
	}
}

func isMP4(header []byte, size int64) bool {
	if len(header) < 12 || !bytes.Equal(header[4:8], []byte("ftyp")) {
		return false
	}
	boxSize := int64(header[0])<<24 | int64(header[1])<<16 | int64(header[2])<<8 | int64(header[3])
	if boxSize < 12 || boxSize > size {
		return false
	}
	brand := string(header[8:12])
	return strings.HasPrefix(brand, "mp4") || strings.HasPrefix(brand, "iso") ||
		strings.HasPrefix(brand, "M4") || brand == "avc1" || brand == "dash"
}

func isWebM(header []byte) bool {
	return len(header) >= 8 && bytes.Equal(header[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) &&
		bytes.Contains(bytes.ToLower(header), []byte("webm"))
}

func (s *Server) submitTask(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.ActorType != "child" {
		problem(w, 403, "forbidden", "child access required")
		return
	}
	iid := chi.URLParam(r, "id")
	if x.SelectedChildID == "" {
		problem(w, 403, "forbidden", "child selection required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 101<<20)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		problem(w, 413, "upload_too_large", "evidence exceeds 100 MB")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	files := r.MultipartForm.File["files"]
	if len(files) > 6 {
		problem(w, 400, "too_many_files", "at most 6 files are allowed")
		return
	}
	type upload struct {
		h                   *multipart.FileHeader
		kind, mimeType, ext string
	}
	var total int64
	validated := make([]upload, 0, len(files))
	for _, h := range files {
		total += h.Size
		kind, mimeType, ext, ok := inspectUpload(h)
		if !ok {
			problem(w, 415, "unsupported_media", "file content is not a supported image or video")
			return
		}
		validated = append(validated, upload{h: h, kind: kind, mimeType: mimeType, ext: ext})
	}
	if total > 100<<20 {
		problem(w, 413, "upload_too_large", "evidence exceeds 100 MB")
		return
	}
	var child, status string
	err := s.db.QueryRow(`SELECT child_id,status FROM task_instances WHERE id=? AND family_id=?`, iid, x.FamilyID).Scan(&child, &status)
	if err != nil {
		problem(w, 404, "not_found", "task not found")
		return
	}
	if x.ActorType == "child" && child != x.ActorID {
		problem(w, 403, "forbidden", "task belongs to another child")
		return
	}
	if child != x.SelectedChildID || !(status == "todo" || status == "rejected") {
		problem(w, 409, "invalid_state", "task cannot be submitted")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, 400, "idempotency_required", "Idempotency-Key is required")
		return
	}
	var prior int
	if s.db.QueryRow(`SELECT status_code FROM idempotency_keys WHERE family_id=? AND actor_id=? AND operation='submit' AND key=?`, x.FamilyID, x.ActorID, key).Scan(&prior) == nil {
		writeJSON(w, prior, map[string]bool{"replayed": true})
		return
	}
	type saved struct {
		h                            *multipart.FileHeader
		storage, aid, kind, mimeType string
	}
	savedFiles := []saved{}
	cleanup := func() {
		for _, v := range savedFiles {
			_ = os.Remove(filepath.Join(s.mediaDir, v.storage))
		}
	}
	for _, candidate := range validated {
		h := candidate.h
		src, e := h.Open()
		if e != nil {
			cleanup()
			s.uploadError(w, r, e)
			return
		}
		storage := id("media") + candidate.ext
		dst, e := os.OpenFile(filepath.Join(s.mediaDir, storage), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e == nil {
			_, e = io.Copy(dst, src)
			_ = dst.Close()
		}
		_ = src.Close()
		if e != nil {
			cleanup()
			s.uploadError(w, r, e)
			return
		}
		savedFiles = append(savedFiles, saved{h, storage, id("att"), candidate.kind, candidate.mimeType})
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	sid := id("sub")
	now := nowText(s.now())
	res, err := tx.Exec(`UPDATE task_instances SET status='pending_review' WHERE id=? AND family_id=? AND child_id=? AND status IN ('todo','rejected')`, iid, x.FamilyID, child)
	if err == nil {
		var changed int64
		changed, err = res.RowsAffected()
		if err == nil && changed != 1 {
			_ = tx.Rollback()
			cleanup()
			problem(w, 409, "conflict", "task is no longer available for submission")
			return
		}
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO task_submissions(id,family_id,task_instance_id,child_id,note,submitted_at) VALUES(?,?,?,?,?,?)`, sid, x.FamilyID, iid, child, r.FormValue("note"), now)
	}
	if err == nil {
		for _, v := range savedFiles {
			_, err = tx.Exec(`INSERT INTO attachments(id,family_id,submission_id,original_name,storage_name,media_type,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, v.aid, x.FamilyID, sid, filepath.Base(v.h.Filename), v.storage, v.kind, v.mimeType, v.h.Size, now)
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'submit',?,200,'{}',?)`, x.FamilyID, x.ActorID, key, now)
	}
	if err != nil {
		_ = tx.Rollback()
		cleanup()
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"id": sid})
}

func (s *Server) reviewTask(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	iid := chi.URLParam(r, "id")
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, 400, "idempotency_required", "Idempotency-Key is required")
		return
	}
	var in struct {
		Approved bool   `json:"approved"`
		Note     string `json:"note"`
	}
	if decode(r, &in) != nil {
		problem(w, 400, "invalid_request", "invalid JSON")
		return
	}
	var prior int
	if s.db.QueryRow(`SELECT status_code FROM idempotency_keys WHERE family_id=? AND actor_id=? AND operation='review' AND key=?`, x.FamilyID, x.ActorID, key).Scan(&prior) == nil {
		writeJSON(w, prior, map[string]bool{"replayed": true})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var sid, child, title, status string
	var points int
	err = tx.QueryRow(`SELECT s.id,i.child_id,i.title,i.points,i.status FROM task_instances i JOIN task_submissions s ON s.task_instance_id=i.id AND s.reviewed_at IS NULL WHERE i.id=? AND i.family_id=? ORDER BY s.submitted_at DESC LIMIT 1`, iid, x.FamilyID).Scan(&sid, &child, &title, &points, &status)
	if err != nil || status != "pending_review" {
		problem(w, 409, "invalid_state", "no pending submission")
		return
	}
	now := nowText(s.now())
	approved := 0
	newStatus := "rejected"
	if in.Approved {
		approved = 1
		newStatus = "completed"
	}
	_, err = tx.Exec(`UPDATE task_submissions SET reviewed_at=?,review_note=?,approved=? WHERE id=? AND family_id=?`, now, in.Note, approved, sid, x.FamilyID)
	if err == nil {
		_, err = tx.Exec(`UPDATE task_instances SET status=? WHERE id=? AND family_id=?`, newStatus, iid, x.FamilyID)
	}
	if err == nil && in.Approved {
		lid := id("led")
		res, e := tx.Exec(`INSERT OR IGNORE INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,?,'task',?,?,?)`, lid, x.FamilyID, child, points, "earned", iid, "完成「"+title+"」", now)
		err = e
		if err == nil {
			n, _ := res.RowsAffected()
			if n == 1 {
				growth := points / 5
				if growth < 1 {
					growth = 1
				}
				_, err = tx.Exec(`UPDATE children SET points_balance=points_balance+?,experience=experience+?,level=1+CAST((experience+?)/100 AS INTEGER) WHERE id=? AND family_id=?`, points, growth, growth, child, x.FamilyID)
			}
		}
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'review',?,200,'{}',?)`, x.FamilyID, x.ActorID, key, now)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"approved": in.Approved})
}

type wishInput struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	PointsCost  int    `json:"pointsCost"`
	Icon        string `json:"icon"`
	Color       string `json:"color"`
	IsActive    bool   `json:"isActive"`
}

func (s *Server) saveWish(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	var in wishInput
	if decode(r, &in) != nil || strings.TrimSpace(in.Title) == "" || in.PointsCost < 1 {
		problem(w, 400, "invalid_request", "valid title and cost required")
		return
	}
	wid := chi.URLParam(r, "id")
	now := nowText(s.now())
	active := 0
	if in.IsActive {
		active = 1
	}
	if wid == "" {
		wid = id("wish")
		_, err := s.db.Exec(`INSERT INTO wishes(id,family_id,title,description,points_cost,icon,color,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, wid, x.FamilyID, strings.TrimSpace(in.Title), in.Description, in.PointsCost, in.Icon, in.Color, active, now, now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	} else {
		res, err := s.db.Exec(`UPDATE wishes SET title=?,description=?,points_cost=?,icon=?,color=?,is_active=?,updated_at=? WHERE id=? AND family_id=? AND deleted_at IS NULL`, strings.TrimSpace(in.Title), in.Description, in.PointsCost, in.Icon, in.Color, active, now, wid, x.FamilyID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			problem(w, 404, "not_found", "wish not found")
			return
		}
	}
	writeJSON(w, 200, map[string]string{"id": wid})
}
func (s *Server) deleteWish(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	res, err := s.db.Exec(`UPDATE wishes SET deleted_at=?,is_active=0 WHERE id=? AND family_id=? AND deleted_at IS NULL`, nowText(s.now()), chi.URLParam(r, "id"), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		problem(w, 404, "not_found", "wish not found")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) redeemWish(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.ActorType != "child" {
		problem(w, 403, "forbidden", "child access required")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, 403, "forbidden", "child selection required")
		return
	}
	if x.ActorType == "child" && x.ActorID != x.SelectedChildID {
		problem(w, 403, "forbidden", "wrong child")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, 400, "idempotency_required", "Idempotency-Key is required")
		return
	}
	wid := chi.URLParam(r, "id")
	var prior int
	if s.db.QueryRow(`SELECT status_code FROM idempotency_keys WHERE family_id=? AND actor_id=? AND operation='redeem' AND key=?`, x.FamilyID, x.ActorID, key).Scan(&prior) == nil {
		writeJSON(w, prior, map[string]bool{"replayed": true})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var title string
	var cost, active int
	err = tx.QueryRow(`SELECT title,points_cost,is_active FROM wishes WHERE id=? AND family_id=? AND deleted_at IS NULL`, wid, x.FamilyID).Scan(&title, &cost, &active)
	if err != nil || active != 1 {
		problem(w, 409, "wish_unavailable", "wish is unavailable")
		return
	}
	res, err := tx.Exec(`UPDATE children SET points_balance=points_balance-? WHERE id=? AND family_id=? AND points_balance>=?`, cost, x.SelectedChildID, x.FamilyID, cost)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		problem(w, 409, "insufficient_points", "not enough points")
		return
	}
	rid := id("red")
	now := nowText(s.now())
	_, err = tx.Exec(`INSERT INTO redemptions(id,family_id,wish_id,wish_title,child_id,points_cost,created_at) VALUES(?,?,?,?,?,?,?)`, rid, x.FamilyID, wid, title, x.SelectedChildID, cost, now)
	if err == nil {
		_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,?,'redemption',?,?,?)`, id("led"), x.FamilyID, x.SelectedChildID, -cost, "spent", rid, "兑换「"+title+"」", now)
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'redeem',?,200,'{}',?)`, x.FamilyID, x.ActorID, key, now)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"id": rid})
}

func (s *Server) completeRedemption(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.ActorType != "child" {
		problem(w, 403, "forbidden", "child access required")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, 403, "forbidden", "child selection required")
		return
	}
	if x.ActorID != x.SelectedChildID {
		problem(w, 403, "forbidden", "wrong child")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 101<<20)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		problem(w, 413, "upload_too_large", "evidence exceeds 100 MB")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	// Completion is one record: the timestamp, an optional note and the child's
	// own photos/videos. Undoing it clears the record, so those are the only
	// files this handler ever reads.
	completed := r.FormValue("completed") == "true"
	var files []*multipart.FileHeader
	if completed {
		files = r.MultipartForm.File["files"]
	}
	if len(files) > 6 {
		problem(w, 400, "too_many_files", "at most 6 files are allowed")
		return
	}
	type upload struct {
		h                   *multipart.FileHeader
		kind, mimeType, ext string
	}
	var total int64
	validated := make([]upload, 0, len(files))
	for _, h := range files {
		total += h.Size
		kind, mimeType, ext, ok := inspectUpload(h)
		if !ok {
			problem(w, 415, "unsupported_media", "file content is not a supported image or video")
			return
		}
		validated = append(validated, upload{h: h, kind: kind, mimeType: mimeType, ext: ext})
	}
	if total > 100<<20 {
		problem(w, 413, "upload_too_large", "evidence exceeds 100 MB")
		return
	}
	type saved struct {
		h                            *multipart.FileHeader
		storage, aid, kind, mimeType string
	}
	savedFiles := []saved{}
	cleanup := func() {
		for _, v := range savedFiles {
			_ = os.Remove(filepath.Join(s.mediaDir, v.storage))
		}
	}
	for _, candidate := range validated {
		h := candidate.h
		src, e := h.Open()
		if e != nil {
			cleanup()
			s.uploadError(w, r, e)
			return
		}
		storage := id("media") + candidate.ext
		dst, e := os.OpenFile(filepath.Join(s.mediaDir, storage), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e == nil {
			_, e = io.Copy(dst, src)
			_ = dst.Close()
		}
		_ = src.Close()
		if e != nil {
			cleanup()
			s.uploadError(w, r, e)
			return
		}
		savedFiles = append(savedFiles, saved{h, storage, id("att"), candidate.kind, candidate.mimeType})
	}
	rid := chi.URLParam(r, "id")
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var stale []string
	if !completed {
		var rows *sql.Rows
		rows, err = tx.Query(`SELECT storage_name FROM attachments WHERE family_id=? AND redemption_id=?`, x.FamilyID, rid)
		for err == nil && rows.Next() {
			var name string
			if err = rows.Scan(&name); err == nil {
				stale = append(stale, name)
			}
		}
		if rows != nil {
			rows.Close()
		}
	}
	now := nowText(s.now())
	var res sql.Result
	if err == nil && completed {
		res, err = tx.Exec(`UPDATE redemptions SET completed_at=?,completed_note=? WHERE id=? AND family_id=? AND child_id=?`, now, nullString(strings.TrimSpace(r.FormValue("note"))), rid, x.FamilyID, x.SelectedChildID)
	}
	if err == nil && !completed {
		res, err = tx.Exec(`UPDATE redemptions SET completed_at=NULL,completed_note=NULL WHERE id=? AND family_id=? AND child_id=?`, rid, x.FamilyID, x.SelectedChildID)
		if err == nil {
			_, err = tx.Exec(`DELETE FROM attachments WHERE family_id=? AND redemption_id=?`, x.FamilyID, rid)
		}
	}
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		cleanup()
		problem(w, 404, "not_found", "redemption not found")
		return
	}
	for _, v := range savedFiles {
		_, err = tx.Exec(`INSERT INTO attachments(id,family_id,redemption_id,original_name,storage_name,media_type,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, v.aid, x.FamilyID, rid, filepath.Base(v.h.Filename), v.storage, v.kind, v.mimeType, v.h.Size, now)
		if err != nil {
			break
		}
	}
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	for _, name := range stale {
		_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(name)))
	}
	w.WriteHeader(204)
}

func (s *Server) media(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	var storage, name, mimeType string
	var created string
	err := s.db.QueryRow(`SELECT storage_name,original_name,mime_type,created_at FROM attachments WHERE id=? AND family_id=?`, chi.URLParam(r, "id"), x.FamilyID).Scan(&storage, &name, &mimeType, &created)
	if err != nil {
		problem(w, 404, "not_found", "media not found")
		return
	}
	f, err := os.Open(filepath.Join(s.mediaDir, filepath.Base(storage)))
	if err != nil {
		problem(w, 404, "not_found", "media not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	t, _ := time.Parse(time.RFC3339Nano, created)
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": name}))
	http.ServeContent(w, r, name, t, io.NewSectionReader(f, 0, st.Size()))
}
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	cid := x.SelectedChildID
	loc, err := s.familyLocation(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	today := s.now().In(loc)
	start := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -6)
	startDate, endDate := start.Format("2006-01-02"), today.Format("2006-01-02")

	var total int
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM task_instances WHERE family_id=? AND child_id=? AND template_id IS NOT NULL AND due_date BETWEEN ? AND ?`, x.FamilyID, cid, startDate, endDate).Scan(&total); err != nil {
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
	daily := make([]dailyStat, 7)
	dailyIndex := map[string]int{}
	weekdayLabels := [...]string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}
	for index := range daily {
		date := start.AddDate(0, 0, index)
		daily[index] = dailyStat{Date: date.Format("2006-01-02"), Label: weekdayLabels[date.Weekday()]}
		dailyIndex[daily[index].Date] = index
	}
	categoryCounts := map[string]int{}
	completed := 0
	rows, err := s.db.Query(`SELECT i.category,s.reviewed_at FROM task_submissions s JOIN task_instances i ON i.id=s.task_instance_id WHERE s.family_id=? AND s.child_id=? AND s.approved=1 AND s.reviewed_at IS NOT NULL`, x.FamilyID, cid)
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
	rows, err = s.db.Query(`SELECT amount,created_at FROM point_ledger WHERE family_id=? AND child_id=?`, x.FamilyID, cid)
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

	categories := make([]categoryStat, 0, len(categoryCounts))
	for _, name := range []string{"生活自理", "家庭责任", "学习成长"} {
		count := categoryCounts[name]
		percent := 0
		if completed > 0 {
			percent = count * 100 / completed
		}
		categories = append(categories, categoryStat{Name: name, Count: count, Percent: percent})
	}
	writeJSON(w, 200, map[string]any{"totalTasks": total, "completedTasks": completed, "earnedPoints": earned, "spentPoints": spent, "daily": daily, "categories": categories})
}
