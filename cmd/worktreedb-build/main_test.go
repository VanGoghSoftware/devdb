package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// two well-formed, distinct sha256 digests for the tests below.
var (
	digestA = "sha256:" + strings.Repeat("ab", 32) // 64 hex
	digestB = "sha256:" + strings.Repeat("cd", 32) // 64 hex
)

func writeDockerfile(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "Dockerfile")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// engine emits a well-formed engine FROM line pinned to d.
func engine(d string) string {
	return "FROM ghcr.io/vangoghsoftware/worktreedb-neon-engine@" + d + " AS neon-binaries\n"
}

// TestCheckEngineDigestPin_Match: every Dockerfile form that still pins the engine base to
// the wanted digest must pass, across the indentation/case/flag/stage/line-ending variants.
func TestCheckEngineDigestPin_Match(t *testing.T) {
	cases := []struct{ name, body string }{
		{"canonical single stage", engine(digestA) + "FROM node:22-bookworm-slim\n"},
		{"leading indentation", "  " + engine(digestA)},
		{"lowercase from", "from ghcr.io/x/worktreedb-neon-engine@" + digestA + " AS x\n"},
		{"--platform flag", "FROM --platform=$BUILDPLATFORM ghcr.io/x/worktreedb-neon-engine@" + digestA + " AS x\n"},
		{"engine as non-first stage", "FROM node:22\nRUN echo hi\n" + engine(digestA)},
		{"CRLF line ending", "FROM ghcr.io/x/worktreedb-neon-engine@" + digestA + "\r\n"},
		{"digest at EOF, no newline", "FROM ghcr.io/x/worktreedb-neon-engine@" + digestA},
		{"two engine stages, both pinned", engine(digestA) + engine(digestA)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkEngineDigestPin(writeDockerfile(t, tc.body), digestA); got != "" {
				t.Fatalf("want match (no problem), got %q", got)
			}
		})
	}
}

// TestCheckEngineDigestPin_Problem: any engine FROM line NOT pinned to the wanted digest —
// drift, tag, malformed, over-length, or bare — must be surfaced, including when it is a
// SECOND stage behind a correctly-pinned first stage (the silent-miss path).
func TestCheckEngineDigestPin_Problem(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub []string // all must appear in the returned problem
	}{
		{"single drifted digest", "FROM ghcr.io/x/worktreedb-neon-engine@" + digestB + " AS x\n", []string{"not pinned", digestB, digestA}},
		{"second stage drifts", engine(digestA) + "FROM ghcr.io/x/worktreedb-neon-engine@" + digestB + " AS b\n", []string{"not pinned", digestB}},
		{"second stage tag-pinned", engine(digestA) + "FROM ghcr.io/x/worktreedb-neon-engine:latest AS b\n", []string{"not pinned", ":latest"}},
		{"second stage malformed digest", engine(digestA) + "FROM ghcr.io/x/worktreedb-neon-engine@" + digestA + "-bad AS b\n", []string{"not pinned", "-bad"}},
		{"bare engine ref (unpinned)", "FROM ghcr.io/x/worktreedb-neon-engine AS x\n", []string{"not pinned"}},
		{"over-length digest", "FROM ghcr.io/x/worktreedb-neon-engine@sha256:" + strings.Repeat("a", 65) + " AS x\n", []string{"not pinned"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := checkEngineDigestPin(writeDockerfile(t, tc.body), digestA)
			for _, sub := range tc.wantSub {
				if !strings.Contains(got, sub) {
					t.Fatalf("problem %q missing expected substring %q", got, sub)
				}
			}
		})
	}
}

// TestCheckEngineDigestPin_NoLine: a Dockerfile with no engine base line — none at all, a
// look-alike image name, a commented-out line — reports the missing line (fails loud).
func TestCheckEngineDigestPin_NoLine(t *testing.T) {
	cases := []struct{ name, body string }{
		{"no engine line", "FROM node:22-bookworm-slim\nRUN echo hi\n"},
		{"look-alike image name", "FROM ghcr.io/x/worktreedb-neon-engine-foo@" + digestA + " AS x\n"},
		{"commented out", "# FROM ghcr.io/x/worktreedb-neon-engine@" + digestA + "\nFROM node:22\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := checkEngineDigestPin(writeDockerfile(t, tc.body), digestA)
			if !strings.Contains(got, "engine base line") {
				t.Fatalf("want a no-engine-line problem, got %q", got)
			}
		})
	}
}

func TestCheckEngineDigestPin_Unreadable(t *testing.T) {
	got := checkEngineDigestPin(filepath.Join(t.TempDir(), "does-not-exist"), digestA)
	if !strings.Contains(got, "cannot read") {
		t.Fatalf("want a read error, got %q", got)
	}
}

// TestCmdCheckManifestWiresRealRepo is an end-to-end smoke test: it runs the whole
// check-manifest subcommand against the REAL repo files (repoRoot walks up from this package
// dir). It proves checkEngineDigestPin is actually wired into cmdCheckManifest and that the
// shipped docker/Dockerfile's engine FROM still matches versions.json's engine digest — a
// regression that unwired the cross-check or drifted the real files would fail here, not just
// in the isolated helper tests. Stdout is muted so a passing run stays quiet; stderr (which
// carries any failure detail) is left intact.
func TestCmdCheckManifestWiresRealRepo(t *testing.T) {
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()
	orig := os.Stdout
	os.Stdout = devnull
	defer func() { os.Stdout = orig }()
	if code := cmdCheckManifest(nil); code != 0 {
		os.Stdout = orig
		t.Fatalf("cmdCheckManifest(nil) on the real repo returned %d, want 0", code)
	}
}
