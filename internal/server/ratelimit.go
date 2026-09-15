package server

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// Auth throttling. The parent password is the only credential the app has,
// and every verification allocates 64 MiB, so the public auth endpoints need a
// request brake and a bound on hashing.
//
// Two independent budgets:
//   - authIP bounds requests per client address, which is what actually
//     protects the process and the argon2 gate from being hammered.
//   - authFail bounds credential *failures* per family, which is what protects
//     the password. A correct password never consumes it, so a busy household
//     cannot lock itself out and a guessing child cannot deny the parent end.
const (
	authIPBurst    = 60       // requests per client address
	authIPRefill   = 1.0      // tokens per second
	authFailBurst  = 10       // credential failures per family actor
	authFailRefill = 1.0 / 30 // tokens per second
	argon2Slots    = 4        // concurrent argon2 calls; 64 MiB each
	bucketIdle     = 30 * time.Minute
)

// bucket is a token bucket. Limiters are keyed by an opaque string (client
// address, family actor) so one noisy source cannot starve the others.
type bucket struct {
	tokens float64
	last   time.Time
}

type limiter struct {
	mu      sync.Mutex
	burst   float64
	refill  float64
	buckets map[string]*bucket
}

func newLimiter(burst, refill float64) *limiter {
	return &limiter{burst: burst, refill: refill, buckets: map[string]*bucket{}}
}

// take refills key from the elapsed time and returns its bucket. A key seen
// for the first time starts full.
func (l *limiter) take(key string, now time.Time) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed.Seconds()*l.refill)
	}
	b.last = now
	return b
}

// allow consumes one token for key, reporting whether it was available.
func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.take(key, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// allowCheck reports whether key has budget left without consuming it.
func (l *limiter) allowCheck(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.take(key, now).tokens >= 1
}

// evict drops buckets untouched for longer than idle so the map stays bounded
// by the number of distinct recent callers.
func (l *limiter) evict(now time.Time, idle time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		if now.Sub(b.last) > idle {
			delete(l.buckets, k)
		}
	}
}

// clientAddr is the TCP peer address. Forwarded headers are deliberately
// ignored: without a configured trusted proxy, honouring X-Forwarded-For would
// let a client choose its own bucket.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// authLimit throttles the public credential endpoints per client address.
func (s *Server) authLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authIP.allow(clientAddr(r), s.now()) {
			problem(w, 429, "too_many_requests", "too many requests; try again later")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authFailureKey names the credential budget for one actor of a family: the
// resolved family row, so client input cannot mint unbounded buckets.
func authFailureKey(familyCode, actor string) string {
	return strings.ToUpper(strings.TrimSpace(familyCode)) + ":" + actor
}

// authBudgetLeft reports whether the credential-failure budget is unexhausted.
func (s *Server) authBudgetLeft(key string) bool {
	return s.authFailures.allowCheck(key, s.now())
}

// recordAuthFailure charges one guess against the credential budget.
func (s *Server) recordAuthFailure(key string) {
	_ = s.authFailures.allow(key, s.now())
}

// acquireHashSlot reserves one argon2 slot, or gives up when ctx is done.
func (s *Server) acquireHashSlot(ctx context.Context) error {
	select {
	case s.hashGate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) releaseHashSlot() { <-s.hashGate }

// hashPassword and verifyPassword serialize argon2 work: each call allocates
// 64 MiB, so unbounded concurrency here is a memory exhaustion vector.
func (s *Server) hashPassword(ctx context.Context, value string) (string, error) {
	if err := s.acquireHashSlot(ctx); err != nil {
		return "", err
	}
	defer s.releaseHashSlot()
	return hashSecret(value)
}

func (s *Server) verifyPassword(ctx context.Context, encoded, value string) (bool, error) {
	if err := s.acquireHashSlot(ctx); err != nil {
		return false, err
	}
	defer s.releaseHashSlot()
	return verifySecret(encoded, value), nil
}

// recoverPanic turns a handler panic into a logged 500 so a single bad request
// cannot leak a stack trace or leave the client without a response.
func recoverPanic(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &responseTracker{ResponseWriter: w}
		defer func() {
			if v := recover(); v != nil {
				log.Error("panic recovered", "method", r.Method, "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				if !tracked.wrote {
					problem(tracked, 500, "internal", "internal server error")
				}
			}
		}()
		next.ServeHTTP(tracked, r)
	})
}

// responseTracker records whether a response was already started, so a
// recovered panic does not append a second status to a committed response.
type responseTracker struct {
	http.ResponseWriter
	wrote bool
}

func (t *responseTracker) WriteHeader(status int) {
	t.wrote = true
	t.ResponseWriter.WriteHeader(status)
}

func (t *responseTracker) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// internalError logs the underlying failure and answers with a generic 500 so
// database and filesystem details never reach the client.
func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err.Error())
	problem(w, 500, "internal", "internal server error")
}

// uploadError is internalError with the upload-specific error code.
func (s *Server) uploadError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("upload failed", "method", r.Method, "path", r.URL.Path, "err", err.Error())
	problem(w, 500, "upload_failed", "upload failed")
}

// shed answers 503 when the hash gate is saturated and ctx gives up waiting.
func (s *Server) shed(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Warn("request shed", "method", r.Method, "path", r.URL.Path, "err", err.Error())
	problem(w, 503, "unavailable", "server is busy; try again later")
}

// hashFailure routes a failed hash gate acquire: an abandoned request is load
// shedding, anything else is an internal fault worth a 500.
func (s *Server) hashFailure(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		s.shed(w, r, err)
		return
	}
	s.internalError(w, r, err)
}
