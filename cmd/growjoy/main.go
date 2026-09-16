package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"growjoy/internal/server"
)

// sweepInterval is how often expired sessions and stale idempotency keys are
// reclaimed while serving.
const sweepInterval = time.Hour

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func open() (*server.Server, error) {
	return server.Open(server.Config{DBPath: env("GROWJOY_DB", "data/growjoy.db"), MediaDir: env("GROWJOY_MEDIA", "data/media"), DistDir: env("GROWJOY_DIST", "dist"), SecureCookies: env("GROWJOY_SECURE_COOKIES", "false") == "true"}, slog.Default())
}
func main() {
	if err := run(); err != nil {
		slog.Error("growjoy failed", "error", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		return admin(os.Args[2:])
	}
	if len(os.Args) > 1 && os.Args[1] == "seed-demo" {
		return seed(os.Args[2:])
	}
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", env("GROWJOY_ADDR", "127.0.0.1:8080"), "listen address")
	demo := fs.Bool("demo", false, "create/update deterministic DEMO family")
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	app, err := open()
	if err != nil {
		return err
	}
	defer app.Close()
	if *demo {
		if err = app.EnsureDemo(context.Background()); err != nil {
			return err
		}
	}
	httpServer := &http.Server{Addr: *addr, Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second}
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	// Expired sessions and stale idempotency keys are only reclaimed here.
	sweepCtx, stopSweep := context.WithCancel(context.Background())
	defer stopSweep()
	if err := app.Sweep(sweepCtx); err != nil {
		slog.Warn("sweep failed", "err", err)
	}
	go func() {
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sweepCtx.Done():
				return
			case <-ticker.C:
				if err := app.Sweep(sweepCtx); err != nil {
					slog.Warn("sweep failed", "err", err)
				}
			}
		}
	}()

	go func() {
		<-done
		stopSweep()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	slog.Info("GrowJoy listening", "addr", *addr)
	err = httpServer.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func admin(args []string) error {
	if len(args) == 0 || args[0] != "create-family" {
		return fmt.Errorf("usage: growjoy admin create-family [flags]")
	}
	fs := flag.NewFlagSet("create-family", flag.ContinueOnError)
	code := fs.String("code", "", "family code")
	name := fs.String("name", "", "family name")
	user := fs.String("username", "parent", "parent username (recorded only; sign-in uses the password)")
	display := fs.String("display-name", "家长", "display name")
	password := fs.String("password", "", "parent password (exactly 4 digits)")
	tz := fs.String("timezone", "Asia/Shanghai", "IANA timezone")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	app, err := open()
	if err != nil {
		return err
	}
	defer app.Close()
	return app.CreateFamily(context.Background(), server.FamilyInput{Code: *code, Name: *name, Timezone: *tz, Username: *user, DisplayName: *display, Password: *password})
}
func seed(args []string) error {
	fs := flag.NewFlagSet("seed-demo", flag.ContinueOnError)
	code := fs.String("family", "DEMO", "family code")
	if err := fs.Parse(args); err != nil {
		return err
	}
	app, err := open()
	if err != nil {
		return err
	}
	defer app.Close()
	return app.SeedDemo(context.Background(), *code)
}
