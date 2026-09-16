package main

import (
	"archive/tar"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"growjoy/internal/server"
)

// version is stamped at build time:
// go build -ldflags "-X main.version=$(git describe --always --dirty)" ./cmd/growjoy
var version = "dev"

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
	return server.Open(server.Config{DBPath: env("GROWJOY_DB", "data/growjoy.db"), MediaDir: env("GROWJOY_MEDIA", "data/media"), DistDir: env("GROWJOY_DIST", "dist"), SecureCookies: env("GROWJOY_SECURE_COOKIES", "false") == "true", Version: version}, slog.Default())
}
func main() {
	if err := run(); err != nil {
		slog.Error("growjoy failed", "error", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "admin":
			return admin(os.Args[2:])
		case "seed-demo":
			return seed(os.Args[2:])
		case "backup":
			return backup(os.Args[2:])
		case "gc":
			return gc(os.Args[2:])
		}
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
	// Which family this database holds is a deployment fact: the SPA never asks
	// for a code, so the boot log is the only place it surfaces.
	if code, err := app.ServingFamily(context.Background()); err != nil {
		return err
	} else if code != "" {
		slog.Info("serving family", "code", code)
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

// backup writes a consistent snapshot of the database plus the media directory
// into --out. VACUUM INTO reads a consistent snapshot, so it is safe to run
// while serve is up.
func backup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	out := fs.String("out", "", "output directory (created if missing)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" {
		return fmt.Errorf("usage: growjoy backup --out <dir>")
	}
	if err := os.MkdirAll(*out, 0700); err != nil {
		return err
	}
	dbPath := filepath.Join(*out, "growjoy.db")
	mediaPath := filepath.Join(*out, "media.tar")
	for _, path := range []string{dbPath, mediaPath} {
		switch _, err := os.Stat(path); {
		case err == nil:
			return fmt.Errorf("output already exists: %s", path)
		case !errors.Is(err, os.ErrNotExist):
			return err
		}
	}
	app, err := open()
	if err != nil {
		return err
	}
	defer app.Close()
	// The path is a bound parameter, so a directory name containing a quote is
	// just a path.
	if _, err = app.DB().Exec(`VACUUM INTO ?`, dbPath); err != nil {
		return fmt.Errorf("vacuum into %s: %w", dbPath, err)
	}
	mediaDir := env("GROWJOY_MEDIA", "data/media")
	file, err := os.OpenFile(mediaPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = tarMedia(file, mediaDir); err != nil {
		_ = file.Close()
		_ = os.Remove(mediaPath)
		return fmt.Errorf("archive %s: %w", mediaDir, err)
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(mediaPath)
		return err
	}
	dbInfo, err := os.Stat(dbPath)
	if err != nil {
		return err
	}
	mediaInfo, err := os.Stat(mediaPath)
	if err != nil {
		return err
	}
	fmt.Printf("database: %s (%d bytes)\n", dbPath, dbInfo.Size())
	fmt.Printf("media: %s (%d bytes)\n", mediaPath, mediaInfo.Size())
	return nil
}

// tarMedia writes every regular file of dir into w under its base name. The
// media directory only ever holds flat upload files, so subdirectories are
// skipped rather than descended into.
func tarMedia(w io.Writer, dir string) error {
	archive := tar.NewWriter(w)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		src, err := os.Open(filepath.Join(dir, entry.Name()))
		if err != nil {
			return err
		}
		err = archive.WriteHeader(&tar.Header{Name: entry.Name(), Mode: 0600, Size: info.Size(), ModTime: info.ModTime()})
		if err == nil {
			_, err = io.Copy(archive, src)
		}
		_ = src.Close()
		if err != nil {
			return err
		}
	}
	return archive.Close()
}

// mediaName is the shape uploads are written under: id("media") plus the
// extension inspectUpload returns. Anything else in the media directory — a
// subdirectory, an editor's backup, a .DS_Store — is not ours to delete.
var mediaName = regexp.MustCompile(`^media_[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$`)

// gc reclaims files in the media directory that no attachments row references.
// They are the residue of a child or task deleted while an upload was in
// flight. It only ever reports unless --delete is given, and it refuses to
// delete anything when the database holds no attachments at all, because that
// usually means GROWJOY_DB points at the wrong file.
func gc(args []string) error {
	fs := flag.NewFlagSet("gc", flag.ContinueOnError)
	media := fs.Bool("media", false, "collect orphaned media files")
	remove := fs.Bool("delete", false, "delete the files instead of only listing them")
	force := fs.Bool("force", false, "delete even when the database has no attachment rows")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !*media {
		return fmt.Errorf("usage: growjoy gc --media [--delete] [--force]")
	}
	app, err := open()
	if err != nil {
		return err
	}
	defer app.Close()
	known := map[string]struct{}{}
	rows, err := app.DB().Query(`SELECT storage_name FROM attachments`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		known[name] = struct{}{}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	mediaDir := env("GROWJOY_MEDIA", "data/media")
	entries, err := os.ReadDir(mediaDir)
	if err != nil {
		return err
	}
	var orphans []string
	var orphanBytes, named int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || !mediaName.MatchString(entry.Name()) {
			continue
		}
		named++
		if _, ok := known[entry.Name()]; ok {
			continue
		}
		orphans = append(orphans, entry.Name())
		orphanBytes += info.Size()
	}
	// Only the destructive run has to be guarded: a dry run that reports what it
	// would remove is informative even when the database looks wrong.
	if *remove && named > 0 && len(known) == 0 && !*force {
		return fmt.Errorf("no attachments in the database but %d media files exist; check GROWJOY_DB (pass --delete --force to remove them anyway)", named)
	}
	if !*remove {
		fmt.Printf("would remove %d files (%d bytes)\n", len(orphans), orphanBytes)
		for _, name := range orphans {
			fmt.Println(name)
		}
		return nil
	}
	removed, freed := 0, int64(0)
	failures := []string{}
	for _, name := range orphans {
		path := filepath.Join(mediaDir, name)
		if info, err := os.Stat(path); err == nil {
			freed += info.Size()
		}
		if err := os.Remove(path); err != nil {
			failures = append(failures, err.Error())
			continue
		}
		removed++
	}
	fmt.Printf("removed %d files (%d bytes)\n", removed, freed)
	if len(failures) > 0 {
		return fmt.Errorf("could not remove %d files: %s", len(failures), strings.Join(failures, "; "))
	}
	return nil
}
