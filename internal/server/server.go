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
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	// A scratch/distroless image has no /usr/share/zoneinfo, and the family
	// timezone is runtime data, so the IANA database is compiled in: without it
	// CreateFamily and familyLocation fail on an otherwise healthy host.
	_ "time/tzdata"
	"unicode/utf8"

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
	// Version is stamped into /health/live; the build injects it with
	// -ldflags "-X main.version=...".
	Version string
}
type Server struct {
	db                *sql.DB
	mediaDir, distDir string
	secureCookies     bool
	version           string
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
	ID             string `json:"id"`
	ChildID        string `json:"childId"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Category       string `json:"category"`
	Points         int    `json:"points"`
	RepeatRule     string `json:"repeatRule"`
	RepeatWeekday  int    `json:"repeatWeekday"`
	RepeatWeekdays []int  `json:"repeatWeekdays"`
	DueDate        string `json:"dueDate"`
	Status         string `json:"status"`
	CreatedAt      string `json:"createdAt"`
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
	ID            string `json:"id"`
	ChildID       string `json:"childId"`
	Amount        int    `json:"amount"`
	Type          string `json:"type"`
	ReferenceType string `json:"referenceType"`
	ReferenceID   string `json:"referenceId"`
	Description   string `json:"description"`
	CreatedAt     string `json:"createdAt"`
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
	// 日历打标只需要官方的放假区间与调休上班日；周末由客户端按星期自己算。
	Holidays       []HolidaySpan `json:"holidays"`
	MakeupWorkdays []string      `json:"makeupWorkdays"`
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
		version:       cfg.Version,
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
		if err = runMigration(db, version, migration); err != nil {
			return err
		}
	}
	return nil
}

// runMigration 跑一个版本号 >= 2 的迁移：整段在一个事务里，跑完才记 schema_migrations。
//
// 外面那对 PRAGMA 是必需的，不是装饰：这类迁移靠 DROP + 改名重建表，而引用表的外键子句
// 写着 ON DELETE CASCADE，DROP 会把引用表真的清空（2026-11-05 线上整月的任务、打卡与积分
// 记录就是这么没的）。事务里改不动 foreign_keys，而 defer_foreign_keys 只推迟提交时的
// 校验、拦不住 DROP 触发的级联；改名也会顺手把别的表的外键子句指向中间表名，留下悬空引用。
// 所以先在连接上关掉外键，跑完再开回来。连接池只有 1 条连接（见 Open），这两条 PRAGMA
// 一定作用在跑迁移的那条连接上。
func runMigration(db *sql.DB, version int, migration []byte) error {
	if _, err := db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		return fmt.Errorf("migration %d: %w", version, err)
	}
	defer func() { _, _ = db.Exec(`PRAGMA foreign_keys=ON`) }()
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
	return nil
}

func (s *Server) Close() error { return s.db.Close() }
func (s *Server) DB() *sql.DB  { return s.db }

// idempotencyRetention bounds how long a completed mutation can be replayed.
// It matches the longest session lifetime: older keys cannot belong to a live
// client, so keeping them only grows the database.
const idempotencyRetention = 30 * 24 * time.Hour

// idempotencyPending is the status_code a live claim writes before its effects
// land. It never reaches a client: a request that finds it answers 409, because
// whoever holds the key may still be mid-flight.
const idempotencyPending = -1

// claimIdempotencyKey takes key for this operation as the first write of tx. It
// reports claimed=true when this request owns the key, or replay=status when an
// earlier request already finished it (idempotencyPending while it is still in
// flight, or when the winner rolled back and left no status to replay).
//
// The claim is what makes a same-key retry exactly-once: a second request's
// INSERT conflicts, so it cannot run the side effects again — checking for the
// key before BeginTx instead let both requests pass the check and the loser
// died on the primary key.
//
// It rolls tx back on every path except a successful claim, so the caller can
// return immediately when claimed is false.
func (s *Server) claimIdempotencyKey(ctx context.Context, tx *sql.Tx, x session, operation, key, now string) (int, bool, error) {
	res, err := tx.ExecContext(ctx, `INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,?,?,?,'',?) ON CONFLICT(family_id,actor_id,operation,key) DO NOTHING`, x.FamilyID, x.ActorID, operation, key, idempotencyPending, now)
	if err != nil {
		_ = tx.Rollback()
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return 0, false, err
	}
	if n == 1 {
		return 0, true, nil
	}
	// Lost the race. Release the claim's transaction before reading: the pool
	// holds a single connection, so querying through s.db with tx open blocks on
	// itself.
	if err := tx.Rollback(); err != nil {
		return 0, false, err
	}
	var prior int
	switch err := s.db.QueryRow(`SELECT status_code FROM idempotency_keys WHERE family_id=? AND actor_id=? AND operation=? AND key=?`, x.FamilyID, x.ActorID, operation, key).Scan(&prior); {
	case err == nil:
		return prior, false, nil
	case errors.Is(err, sql.ErrNoRows):
		// The winner rolled back, so it failed and stored nothing.
		return idempotencyPending, false, nil
	default:
		return 0, false, err
	}
}

// replayOrConflict answers the request that lost a claim: the stored status
// when the winner finished, or 409 when it is still in flight.
func replayOrConflict(w http.ResponseWriter, replay int) {
	if replay == idempotencyPending {
		problem(w, 409, "conflict", "request is still in flight")
		return
	}
	writeJSON(w, replay, map[string]bool{"replayed": true})
}

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
	r.Get("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "version": s.version})
	})
	r.Get("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := s.db.PingContext(r.Context()); err != nil {
			s.log.Error("readiness check failed", "err", err.Error())
			problem(w, 503, "unavailable", "database unavailable")
			return
		}
		family, _, err := s.resolvedFamily(r.Context())
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			s.log.Error("readiness check failed", "err", err.Error())
			problem(w, 503, "unavailable", "database unavailable")
			return
		}
		// Having no family is a legitimate startup state (the SPA answers
		// no_family), but once one exists its timezone must load: /state hard
		// 500s otherwise, so reporting ready would be a lie.
		if family != "" {
			if _, err := s.familyLocation(r.Context(), family); err != nil {
				s.log.Error("readiness check failed", "err", err.Error())
				problem(w, 503, "unavailable", "runtime timezone data unavailable")
				return
			}
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
				c.Post("/{id}/points", s.parentOnly(s.awardPoints))
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
			a.Route("/homework", func(hw chi.Router) {
				hw.Get("/", s.getHomework)
				hw.Post("/", s.parentOnly(s.saveHomework))
				hw.Put("/{id}", s.parentOnly(s.saveHomework))
				hw.Delete("/{id}", s.parentOnly(s.deleteHomework))
				hw.Delete("/{id}/media/{mediaID}", s.parentOnly(s.deleteHomeworkMedia))
				hw.Post("/{id}/done", s.setHomeworkDone)
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
	// A crypto/rand failure must not degrade into an all-zero id: the primary
	// key collision would surface as an unrelated 500, and recoverPanic logs
	// this one with the real cause.
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("generate %s id: %w", prefix, err))
	}
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
	// 代价参数来自库里的一行字，不能无条件相信：一行被改坏的哈希（m/t 取到
	// uint32 上限）会让每次登录都去申请几个 TB，进程直接被 OOM 杀掉。上限按
	// 生产参数（m=65536,t=1,p=4）留足余量，够未来调参，又挡住这种输入。
	if mem < 8*1024 || mem > 256*1024 || tm < 1 || tm > 10 || threads < 1 || threads > 16 {
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
	family, _, err := s.resolvedFamily(r.Context())
	if err != nil {
		s.familyError(w, r, err)
		return
	}
	current, had := s.lookupSession(r)
	if had && current.ActorType == "child" {
		child := s.familyChild(r.Context(), family, current.SelectedChildID)
		if child == "" {
			// The app's default screen means this cookie can be minted before the
			// family has any profile (or after the selected one was removed). Every
			// child-scoped read then filters on an empty child_id and answers empty
			// tables for the rest of the session's 30 days, so the SPA's next boot
			// heals it in place — actor_id mirrors the profile, as always.
			if child = s.firstChild(r.Context(), family); child != "" {
				_, _ = s.db.Exec(`UPDATE sessions SET selected_child_id=?, actor_id=? WHERE id=? AND family_id=?`, child, child, current.ID, family)
			}
		}
		writeJSON(w, 200, map[string]string{"role": "child", "activeChildId": child})
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

// ServingFamily names the family this process serves, so `serve` can log it at
// boot: the SPA never asks for a code, and which family a database holds is a
// deployment fact worth seeing in the logs.
func (s *Server) ServingFamily(ctx context.Context) (string, error) {
	_, code, err := s.resolvedFamily(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return code, err
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
	// 家庭从会话行取，和所有其它写路径一致（resolvedFamily 取的是最老的家庭，
	// 多家庭下就是跨家庭改密码）。code 只用于限流桶的键，仍旧从同一行进库读。
	x := sess(r)
	family := x.FamilyID
	var code string
	if err := s.db.QueryRowContext(r.Context(), `SELECT code FROM families WHERE id=?`, family).Scan(&code); err != nil {
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
		// The child row is already committed, so a failure here answers 500 and
		// leaves the created child visible on the next /state; the client only
		// has to refresh.
		if _, err = s.db.Exec(`UPDATE sessions SET selected_child_id=? WHERE id=? AND family_id=?`, cid, x.ID, x.FamilyID); err != nil {
			s.internalError(w, r, err)
			return
		}
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
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	// The child count and the media list are read inside the transaction: two
	// concurrent deletions must not both pass the last-child check, and an
	// attachment inserted between the read and the commit would be cascaded
	// away with its file left on disk.
	var count int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM children WHERE family_id=?`, x.FamilyID).Scan(&count); err != nil {
		s.internalError(w, r, err)
		return
	}
	if count <= 1 {
		problem(w, 409, "last_child", "at least one child is required")
		return
	}
	mediaFiles := mediaForChild(r.Context(), tx, x.FamilyID, cid)
	var replacement string
	if err = tx.QueryRow(`SELECT id FROM children WHERE family_id=? AND id<>? ORDER BY created_at LIMIT 1`, x.FamilyID, cid).Scan(&replacement); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			problem(w, 409, "last_child", "at least one child is required")
			return
		}
		// 查询本身失败（连接、锁）不是「只剩一个孩子」：按 409 回会把内部故障
		// 说成业务规则，还会让人以为数据没问题。
		s.internalError(w, r, err)
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

// queryer lets the media lookups run either outside a transaction (s.db) or
// inside one (tx). The pool holds a single connection, so a transaction MUST
// read through tx: querying s.db while tx is open would block on itself.
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func mediaForChild(ctx context.Context, q queryer, family, child string) []string {
	rows, err := q.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN task_submissions s ON s.id=a.submission_id WHERE a.family_id=? AND s.child_id=?`, family, child)
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
	rows, err = q.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN redemptions r ON r.id=a.redemption_id WHERE a.family_id=? AND r.child_id=?`, family, child)
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

func mediaForTemplate(ctx context.Context, q queryer, family, template string) []string {
	rows, err := q.QueryContext(ctx, `SELECT a.storage_name FROM attachments a JOIN task_submissions s ON s.id=a.submission_id JOIN task_instances i ON i.id=s.task_instance_id WHERE a.family_id=? AND i.template_id=?`, family, template)
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
	ChildID        string `json:"childId"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Category       string `json:"category"`
	Points         int    `json:"points"`
	RepeatRule     string `json:"repeatRule"`
	RepeatWeekday  int    `json:"repeatWeekday"`
	RepeatWeekdays []int  `json:"repeatWeekdays"`
}

// parseRepeatWeekdays 解析 repeat_weekdays 列（升序去重的 "0".."6" 逗号串），
// 脏数据逐段丢掉；空串返回空集合，调用方按老语义退回 repeat_weekday。
// 永远返回非 nil，/state 的数组不能是 null。
func parseRepeatWeekdays(value string) []int {
	out, seen := []int{}, map[int]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		day, err := strconv.Atoi(part)
		if err != nil || day < 0 || day > 6 || seen[day] {
			continue
		}
		seen[day] = true
		out = append(out, day)
	}
	sort.Ints(out)
	return out
}

// repeatWeekdayList 是读取端的口径：集合为空就用旧字段的那一天。
func repeatWeekdayList(value string, fallback int) []int {
	if days := parseRepeatWeekdays(value); len(days) > 0 {
		return days
	}
	return []int{fallback}
}

// repeatWeekdaysOf 是写入端的口径：把请求里的集合整理成升序去重，一个都没选
// （或全是脏数据）就用旧字段的那一天。调用方已把超出 0..6 的值当成 400 拒掉了。
func repeatWeekdaysOf(days []int, fallback int) []int {
	out, seen := []int{}, map[int]bool{}
	for _, day := range days {
		if day < 0 || day > 6 || seen[day] {
			continue
		}
		seen[day] = true
		out = append(out, day)
	}
	if len(out) == 0 {
		return []int{fallback}
	}
	sort.Ints(out)
	return out
}

// repeatWeekdaysText 把集合写成 repeat_weekdays 列：空集合写空串，也就是「只有
// repeat_weekday 那一天」——单天任务保持老形状，实例的 period_key 不会因此变。
func repeatWeekdaysText(days []int) string {
	parts := make([]string, len(days))
	for i, day := range days {
		parts[i] = strconv.Itoa(day)
	}
	return strings.Join(parts, ",")
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
	for _, day := range in.RepeatWeekdays {
		if day < 0 || day > 6 {
			problem(w, 400, "invalid_request", "repeatWeekdays must be between 0 and 6")
			return
		}
	}
	// 星期集合只有每周任务用。只选一天（或老客户端一个都没发）就把列留空，
	// 用 repeat_weekday 表示；选多天才写串，同时把 repeat_weekday 写成第一天，
	// 只读旧字段的代码不会吃亏。
	firstDay, weekdaysText := in.RepeatWeekday, ""
	var weeklyDays []int
	if in.RepeatRule == "weekly" {
		weeklyDays = repeatWeekdaysOf(in.RepeatWeekdays, in.RepeatWeekday)
		firstDay = weeklyDays[0]
		if len(weeklyDays) > 1 {
			weekdaysText = repeatWeekdaysText(weeklyDays)
		}
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
		_, err := s.db.Exec(`INSERT INTO task_templates(id,family_id,child_id,title,description,category,points,repeat_rule,repeat_weekday,repeat_weekdays,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, tid, x.FamilyID, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, firstDay, weekdaysText, now, now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		// The template row is already written when this fails, so the 500 leaves
		// a template without an instance behind: the next GET /state recreates
		// the instance through ensureInstances, which is cheaper than silently
		// answering 200 with an empty id.
		if err = s.ensureInstances(r.Context(), x.FamilyID); err != nil {
			s.internalError(w, r, err)
			return
		}
		// ensureInstances just ran, so an empty id can only be an internal fault.
		// created_at 是 RFC3339Nano（秒内的小数位会被裁掉），同一秒里建的两个实例
		// 排序不可靠；rowid 才是插入顺序。
		if err = s.db.QueryRow(`SELECT id FROM task_instances WHERE template_id=? AND family_id=? ORDER BY rowid DESC LIMIT 1`, tid, x.FamilyID).Scan(&instance); err != nil || instance == "" {
			if err == nil {
				err = fmt.Errorf("task template %s has no instance", tid)
			}
			s.internalError(w, r, err)
			return
		}
	} else {
		// 改星期之前先看清原来排的是哪几天：只有星期真的变了才重排本周实例，
		// 纯改个标题不该让孩子手里那个 id 消失。
		var templateID, oldRule, oldSet string
		var oldWeekday int
		err := s.db.QueryRow(`SELECT task_instances.template_id,task_templates.repeat_rule,task_templates.repeat_weekday,task_templates.repeat_weekdays FROM task_instances JOIN task_templates ON task_templates.id=task_instances.template_id WHERE task_instances.id=? AND task_instances.family_id=?`, instance, x.FamilyID).Scan(&templateID, &oldRule, &oldWeekday, &oldSet)
		if err != nil {
			problem(w, 404, "not_found", "task not found")
			return
		}
		res, err := s.db.Exec(`UPDATE task_templates SET child_id=?,title=?,description=?,category=?,points=?,repeat_rule=?,repeat_weekday=?,repeat_weekdays=?,updated_at=? WHERE family_id=? AND id=?`, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, firstDay, weekdaysText, now, x.FamilyID, templateID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			problem(w, 404, "not_found", "task not found")
			return
		}
		// 本周已经排好但还没做的实例按新星期重排；交过或确认过的是历史，
		// 留在原日期不动。
		if in.RepeatRule == "weekly" && (oldRule != "weekly" || oldWeekday != firstDay || oldSet != weekdaysText) {
			monday, weekErr := s.weekStart(r.Context(), x.FamilyID)
			if weekErr != nil {
				s.internalError(w, r, weekErr)
				return
			}
			week := monday.Format("2006-01-02")
			if oldSet == "" && oldRule == "weekly" && slices.Contains(weeklyDays, oldWeekday) {
				// 老行用的是「整周一个 key」，那天又还在新集合里，就先把它的 key
				// 迁成新格式：不迁的话 INSERT OR IGNORE 会当成没排过，孩子已经
				// 交过的那一条旁边又冒出一个待办，同一星期几能被确认两次。
				if _, err = s.db.Exec(`UPDATE task_instances SET period_key=? WHERE family_id=? AND template_id=? AND period_key=?`, week+":"+strconv.Itoa(oldWeekday), x.FamilyID, templateID, week); err != nil {
					s.internalError(w, r, err)
					return
				}
			}
			if _, err = s.db.Exec(`DELETE FROM task_instances WHERE family_id=? AND template_id=? AND status='todo' AND (period_key=? OR period_key LIKE ?) AND NOT EXISTS(SELECT 1 FROM task_submissions WHERE task_instance_id=task_instances.id)`, x.FamilyID, templateID, week, week+":%"); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
		// Zero rows is the expected outcome when the instance is already
		// submitted or no longer todo/rejected, so only the error matters.
		if _, err = s.db.Exec(`UPDATE task_instances SET child_id=?,title=?,description=?,category=?,points=?,repeat_rule=?,repeat_weekday=?,repeat_weekdays=? WHERE id=? AND family_id=? AND status IN ('todo','rejected') AND NOT EXISTS(SELECT 1 FROM task_submissions WHERE task_instance_id=task_instances.id)`, in.ChildID, strings.TrimSpace(in.Title), in.Description, in.Category, in.Points, in.RepeatRule, firstDay, weekdaysText, instance, x.FamilyID); err != nil {
			s.internalError(w, r, err)
			return
		}
		// 上面的重排可能刚好把被编辑的那一条删掉了，所以回给前端的 id 要在
		// ensureInstances 排完之后重新取一次，它必须能在随后的 /state 里列出来。
		if err = s.ensureInstances(r.Context(), x.FamilyID); err != nil {
			s.internalError(w, r, err)
			return
		}
		if err = s.db.QueryRow(`SELECT id FROM task_instances WHERE template_id=? AND family_id=? ORDER BY rowid DESC LIMIT 1`, templateID, x.FamilyID).Scan(&instance); err != nil || instance == "" {
			if err == nil {
				err = fmt.Errorf("task template %s has no instance", templateID)
			}
			s.internalError(w, r, err)
			return
		}
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
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	// Inside the transaction, so evidence attached after the read cannot be
	// cascaded away while its file stays on disk.
	files := mediaForTemplate(r.Context(), tx, x.FamilyID, templateID)
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
	// One short note for the parent, same budget as a manual points note: the
	// field is not size-bounded by the multipart limits, so an oversized note
	// would land in SQLite and be resent by every /state.
	note := strings.TrimSpace(r.FormValue("note"))
	if utf8.RuneCountInString(note) > 30 {
		problem(w, 400, "invalid_request", "note must be 30 characters or fewer")
		return
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
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, 400, "idempotency_required", "Idempotency-Key is required")
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
	defer tx.Rollback()
	sid := id("sub")
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, "submit", key, now)
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		// The evidence files were written before the transaction, so a replay
		// must drop its own copies instead of orphaning them.
		cleanup()
		replayOrConflict(w, replay)
		return
	}
	// The instance's state is read after the claim, inside the transaction: a
	// same-key retry has to replay the stored status instead of tripping over
	// the state the request that owns the key already moved.
	var child, status string
	if err = tx.QueryRow(`SELECT child_id,status FROM task_instances WHERE id=? AND family_id=?`, iid, x.FamilyID).Scan(&child, &status); err != nil {
		cleanup()
		problem(w, 404, "not_found", "task not found")
		return
	}
	if child != x.ActorID {
		cleanup()
		problem(w, 403, "forbidden", "task belongs to another child")
		return
	}
	if child != x.SelectedChildID || !(status == "todo" || status == "rejected") {
		cleanup()
		problem(w, 409, "invalid_state", "task cannot be submitted")
		return
	}
	res, err := tx.Exec(`UPDATE task_instances SET status='pending_review' WHERE id=? AND family_id=? AND child_id=? AND status IN ('todo','rejected')`, iid, x.FamilyID, child)
	if err == nil {
		var changed int64
		changed, err = res.RowsAffected()
		if err == nil && changed != 1 {
			cleanup()
			problem(w, 409, "conflict", "task is no longer available for submission")
			return
		}
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO task_submissions(id,family_id,task_instance_id,child_id,note,submitted_at) VALUES(?,?,?,?,?,?)`, sid, x.FamilyID, iid, child, note, now)
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
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'submit',?,200,'{}',?) ON CONFLICT(family_id,actor_id,operation,key) DO UPDATE SET status_code=excluded.status_code,response_body=excluded.response_body`, x.FamilyID, x.ActorID, key, now)
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
	// 和手动积分、提交说明共用 30 字预算：review_note 会随每条 submission 进
	// /state，1 MiB 的备注能把之后每一次刷新都撑大。
	if utf8.RuneCountInString(in.Note) > 30 {
		problem(w, 400, "invalid_request", "note must be at most 30 characters")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, "review", key, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		replayOrConflict(w, replay)
		return
	}
	var sid, child, title, status string
	var points int
	err = tx.QueryRow(`SELECT s.id,i.child_id,i.title,i.points,i.status FROM task_instances i JOIN task_submissions s ON s.task_instance_id=i.id AND s.reviewed_at IS NULL WHERE i.id=? AND i.family_id=? ORDER BY s.submitted_at DESC LIMIT 1`, iid, x.FamilyID).Scan(&sid, &child, &title, &points, &status)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 409, "invalid_state", "no pending submission")
		return
	}
	// 真正的数据库故障不能冒充「没有待确认的提交」，否则线上只看到一句 409。
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if status != "pending_review" {
		problem(w, 409, "invalid_state", "no pending submission")
		return
	}
	approved := 0
	newStatus := "rejected"
	if in.Approved {
		approved = 1
		newStatus = "completed"
	}
	upd, err := tx.Exec(`UPDATE task_submissions SET reviewed_at=?,review_note=?,approved=? WHERE id=? AND family_id=? AND reviewed_at IS NULL`, now, in.Note, approved, sid, x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if n, _ := upd.RowsAffected(); n != 1 {
		problem(w, 409, "conflict", "submission was already reviewed")
		return
	}
	// 和 submitTask 一样用 WHERE 断言状态迁移：改到 0 行说明有人抢先改过。
	upd, err = tx.Exec(`UPDATE task_instances SET status=? WHERE id=? AND family_id=? AND status='pending_review'`, newStatus, iid, x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if n, _ := upd.RowsAffected(); n != 1 {
		problem(w, 409, "conflict", "task state changed")
		return
	}
	if in.Approved {
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
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'review',?,200,'{}',?) ON CONFLICT(family_id,actor_id,operation,key) DO UPDATE SET status_code=excluded.status_code,response_body=excluded.response_body`, x.FamilyID, x.ActorID, key, now)
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

// maxPointsAdjustment bounds one manual award or deduction so a mistyped form
// cannot move a child's balance by an arbitrary amount.
const maxPointsAdjustment = 500

// awardPoints moves a child's balance outside the task flow. A positive amount
// credits points and grows experience exactly like an approved task; a negative
// amount only reduces points_balance, because experience is the total the child
// earned and never decreases.
func (s *Server) awardPoints(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	cid := chi.URLParam(r, "id")
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, 400, "idempotency_required", "Idempotency-Key is required")
		return
	}
	var in struct {
		Amount int    `json:"amount"`
		Note   string `json:"note"`
	}
	if decode(r, &in) != nil || in.Amount == 0 || in.Amount > maxPointsAdjustment || in.Amount < -maxPointsAdjustment {
		problem(w, 400, "invalid_request", "amount must be between -500 and 500, excluding 0")
		return
	}
	note := strings.TrimSpace(in.Note)
	if utf8.RuneCountInString(note) > 30 {
		problem(w, 400, "invalid_request", "note must be 30 characters or fewer")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, "award", key, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		replayOrConflict(w, replay)
		return
	}
	var exists int
	if tx.QueryRow(`SELECT 1 FROM children WHERE id=? AND family_id=?`, cid, x.FamilyID).Scan(&exists) != nil {
		problem(w, 404, "not_found", "child not found")
		return
	}
	lid := id("led")
	desc, entryType := "家长奖励", "earned"
	if in.Amount < 0 {
		desc, entryType = "家长扣除", "spent"
	}
	if note != "" {
		desc += "：" + note
	}
	if in.Amount > 0 {
		growth := in.Amount / 5
		if growth < 1 {
			growth = 1
		}
		_, err = tx.Exec(`UPDATE children SET points_balance=points_balance+?,experience=experience+?,level=1+CAST((experience+?)/100 AS INTEGER) WHERE id=? AND family_id=?`, in.Amount, growth, growth, cid, x.FamilyID)
	} else {
		var res sql.Result
		res, err = tx.Exec(`UPDATE children SET points_balance=points_balance+? WHERE id=? AND family_id=? AND points_balance+?>=0`, in.Amount, cid, x.FamilyID, in.Amount)
		if err == nil {
			if n, _ := res.RowsAffected(); n == 0 {
				problem(w, 409, "insufficient_balance", "child has insufficient points")
				return
			}
		}
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,?,'manual',?,?,?)`, lid, x.FamilyID, cid, in.Amount, entryType, lid, desc, now)
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'award',?,200,'{}',?) ON CONFLICT(family_id,actor_id,operation,key) DO UPDATE SET status_code=excluded.status_code,response_body=excluded.response_body`, x.FamilyID, x.ActorID, key, now)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"id": lid})
}

// IsActive 用指针：decode 关了 DisallowUnknownFields 也只能拒未知字段名，
// 认不出「没传」和「传了 false」。普通 bool 会让一次省略 isActive 的编辑把心愿
// 静默下架（下架/上架只改这一个字段，客户端却习惯送整份 DTO）。
type wishInput struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	PointsCost  int    `json:"pointsCost"`
	Icon        string `json:"icon"`
	Color       string `json:"color"`
	IsActive    *bool  `json:"isActive"`
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
	// 新建默认上架；编辑时没带这个字段就保持原值（nil 绑成 NULL 交给 COALESCE）。
	active := 1
	if in.IsActive != nil && !*in.IsActive {
		active = 0
	}
	var activeArg any
	if in.IsActive != nil {
		activeArg = active
	}
	if wid == "" {
		wid = id("wish")
		_, err := s.db.Exec(`INSERT INTO wishes(id,family_id,title,description,points_cost,icon,color,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, wid, x.FamilyID, strings.TrimSpace(in.Title), in.Description, in.PointsCost, in.Icon, in.Color, active, now, now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	} else {
		res, err := s.db.Exec(`UPDATE wishes SET title=?,description=?,points_cost=?,icon=?,color=?,is_active=COALESCE(?,is_active),updated_at=? WHERE id=? AND family_id=? AND deleted_at IS NULL`, strings.TrimSpace(in.Title), in.Description, in.PointsCost, in.Icon, in.Color, activeArg, now, wid, x.FamilyID)
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
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, "redeem", key, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		replayOrConflict(w, replay)
		return
	}
	var title string
	var cost, active int
	err = tx.QueryRow(`SELECT title,points_cost,is_active FROM wishes WHERE id=? AND family_id=? AND deleted_at IS NULL`, wid, x.FamilyID).Scan(&title, &cost, &active)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && active != 1) {
		problem(w, 409, "wish_unavailable", "wish is unavailable")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
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
	_, err = tx.Exec(`INSERT INTO redemptions(id,family_id,wish_id,wish_title,child_id,points_cost,created_at) VALUES(?,?,?,?,?,?,?)`, rid, x.FamilyID, wid, title, x.SelectedChildID, cost, now)
	if err == nil {
		_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,?,'redemption',?,?,?)`, id("led"), x.FamilyID, x.SelectedChildID, -cost, "spent", rid, "兑换「"+title+"」", now)
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'redeem',?,200,'{}',?) ON CONFLICT(family_id,actor_id,operation,key) DO UPDATE SET status_code=excluded.status_code,response_body=excluded.response_body`, x.FamilyID, x.ActorID, key, now)
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
	// Same 30-character budget as submitTask and awardPoints.
	storedNote := strings.TrimSpace(r.FormValue("note"))
	if utf8.RuneCountInString(storedNote) > 30 {
		problem(w, 400, "invalid_request", "note must be 30 characters or fewer")
		return
	}
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
	// 一次完成请求带的是「这次完成」的全部凭证，而不是增量：重放或再点一次应当替换
	// 上一次的备注与附件，不能越叠越多。旧行在事务里删、旧文件在提交后删。
	var stale []string
	rows, err := tx.Query(`SELECT storage_name FROM attachments WHERE family_id=? AND redemption_id=?`, x.FamilyID, rid)
	for err == nil && rows.Next() {
		var name string
		if err = rows.Scan(&name); err == nil {
			stale = append(stale, name)
		}
	}
	if rows != nil {
		rows.Close()
		if cerr := rows.Err(); err == nil {
			err = cerr
		}
	}
	if err == nil {
		_, err = tx.Exec(`DELETE FROM attachments WHERE family_id=? AND redemption_id=?`, x.FamilyID, rid)
	}
	now := nowText(s.now())
	var res sql.Result
	if err == nil {
		if completed {
			res, err = tx.Exec(`UPDATE redemptions SET completed_at=?,completed_note=? WHERE id=? AND family_id=? AND child_id=?`, now, nullString(storedNote), rid, x.FamilyID, x.SelectedChildID)
		} else {
			res, err = tx.Exec(`UPDATE redemptions SET completed_at=NULL,completed_note=NULL WHERE id=? AND family_id=? AND child_id=?`, rid, x.FamilyID, x.SelectedChildID)
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
	mediaID := chi.URLParam(r, "id")
	var storage, name, mimeType, created, owner string
	err := s.db.QueryRow(`SELECT a.storage_name,a.original_name,a.mime_type,a.created_at,COALESCE(sub.child_id,red.child_id,'') FROM attachments a LEFT JOIN task_submissions sub ON sub.id=a.submission_id LEFT JOIN redemptions red ON red.id=a.redemption_id WHERE a.id=? AND a.family_id=?`, mediaID, x.FamilyID).Scan(&storage, &name, &mimeType, &created, &owner)
	if err == nil && owner != "" && x.ActorType != "parent" && owner != x.SelectedChildID {
		// 同一家庭里孩子之间也不能互读凭证：只按 family_id 过滤的话，知道 id 就能看
		// 兄弟提交的照片。家长端要审作业与心愿，所以家长放行。
		problem(w, 404, "not_found", "media not found")
		return
	}
	if err != nil {
		// 作业媒体不与 attachments 共用一张表（attachments 的 submission/redemption
		// 二选一约束容不下第三个所有者），所以这里退一步查作业表；作业是家长布置的，
		// 同一家庭的每个孩子都能看。
		err = s.db.QueryRow(`SELECT storage_name,original_name,mime_type,created_at FROM homework_media WHERE id=? AND family_id=?`, mediaID, x.FamilyID).Scan(&storage, &name, &mimeType, &created)
	}
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
