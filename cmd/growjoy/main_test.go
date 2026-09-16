package main

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupCLI points the commands at a throwaway database and media directory.
// They read GROWJOY_* themselves (env() in main.go), so the environment is the
// only seam.
func setupCLI(t *testing.T) (dbPath, mediaDir string) {
	t.Helper()
	dir := t.TempDir()
	dbPath = filepath.Join(dir, "cli.db")
	mediaDir = filepath.Join(dir, "media")
	t.Setenv("GROWJOY_DB", dbPath)
	t.Setenv("GROWJOY_MEDIA", mediaDir)
	t.Setenv("GROWJOY_DIST", "")
	return dbPath, mediaDir
}

func createFamilyArgs(code string) []string {
	return []string{"create-family", "--code", code, "--name", "我的家庭", "--username", "parent", "--display-name", "家长", "--password", "2468", "--timezone", "Asia/Shanghai"}
}

func TestCreateFamilyAndSeedDemoCommands(t *testing.T) {
	dbPath, _ := setupCLI(t)
	if err := admin(createFamilyArgs("FAMILY01")); err != nil {
		t.Fatal(err)
	}
	if err := seed([]string{"--family", "FAMILY01"}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var families, children int
	if err = db.QueryRow(`SELECT COUNT(*) FROM families`).Scan(&families); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM children`).Scan(&children); err != nil {
		t.Fatal(err)
	}
	if families != 1 || children != 1 {
		t.Fatalf("families=%d children=%d, want 1 and 1", families, children)
	}
	if err = admin([]string{"nope"}); err == nil {
		t.Fatal("unknown admin subcommand was accepted")
	}
	if err = admin(nil); err == nil {
		t.Fatal("admin without a subcommand was accepted")
	}
}

// GrowJoy only ever serves the oldest family row, so a second one would be
// unreachable; the command refuses instead of creating dead data.
func TestCreateFamilyRefusesASecondFamily(t *testing.T) {
	setupCLI(t)
	if err := admin(createFamilyArgs("FAMILY01")); err != nil {
		t.Fatal(err)
	}
	err := admin(createFamilyArgs("FAMILY02"))
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second family: %v", err)
	}
}

func TestBackupWritesDatabaseAndMediaArchive(t *testing.T) {
	_, mediaDir := setupCLI(t)
	if err := admin(createFamilyArgs("FAMILY01")); err != nil {
		t.Fatal(err)
	}
	evidence := "media_" + strings.Repeat("a", 32) + ".png"
	if err := os.WriteFile(filepath.Join(mediaDir, evidence), []byte("evidence"), 0600); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "snapshot")
	if err := backup([]string{"--out", out}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(out, "growjoy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var families int
	if err = db.QueryRow(`SELECT COUNT(*) FROM families`).Scan(&families); err != nil {
		t.Fatal(err)
	}
	if families != 1 {
		t.Fatalf("families in the snapshot=%d, want 1", families)
	}
	archive, err := os.Stat(filepath.Join(out, "media.tar"))
	if err != nil {
		t.Fatal(err)
	}
	if archive.Size() == 0 {
		t.Fatal("media archive is empty")
	}
	// A second run must not merge into or overwrite the first snapshot.
	if err = backup([]string{"--out", out}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second backup: %v", err)
	}
	if err = backup(nil); err == nil {
		t.Fatal("backup without --out was accepted")
	}
}

func TestGarbageCollectMediaDryRunAndDelete(t *testing.T) {
	_, mediaDir := setupCLI(t)
	if err := admin(createFamilyArgs("FAMILY01")); err != nil {
		t.Fatal(err)
	}
	orphan := "media_" + strings.Repeat("b", 32) + ".png"
	unrelated := "notes.txt"
	for name, content := range map[string]string{orphan: "orphan", unrelated: "keep"} {
		if err := os.WriteFile(filepath.Join(mediaDir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := gc([]string{"--media"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{orphan, unrelated} {
		if _, err := os.Stat(filepath.Join(mediaDir, name)); err != nil {
			t.Fatalf("dry run removed %s: %v", name, err)
		}
	}
	// The fixture never uploaded evidence, so the attachments table is empty and
	// the destructive run needs --force; TestGarbageCollectRefusesWithoutAttachmentRows
	// covers what happens without it.
	if err := gc([]string{"--media", "--delete", "--force"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mediaDir, orphan)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan survived --delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mediaDir, unrelated)); err != nil {
		t.Fatalf("gc removed a file it does not own: %v", err)
	}
	if err := gc(nil); err == nil {
		t.Fatal("gc without --media was accepted")
	}
}

// An empty attachments table plus media files is the signature of GROWJOY_DB
// pointing at the wrong database: deleting then would wipe the media directory.
func TestGarbageCollectRefusesWithoutAttachmentRows(t *testing.T) {
	_, mediaDir := setupCLI(t)
	if err := os.MkdirAll(mediaDir, 0700); err != nil {
		t.Fatal(err)
	}
	orphan := "media_" + strings.Repeat("c", 32) + ".png"
	if err := os.WriteFile(filepath.Join(mediaDir, orphan), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := gc([]string{"--media", "--delete"}); err == nil || !strings.Contains(err.Error(), "no attachments") {
		t.Fatalf("delete without attachment rows: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mediaDir, orphan)); err != nil {
		t.Fatalf("file removed despite the guard: %v", err)
	}
	if err := gc([]string{"--media", "--delete", "--force"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mediaDir, orphan)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("forced delete left the orphan: %v", err)
	}
}
