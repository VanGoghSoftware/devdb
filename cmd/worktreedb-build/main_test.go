package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

func TestPromisedExtensionPins(t *testing.T) {
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, manifestPath))
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}

	want := map[string]string{
		"PG_CRON_VERSION":       "1.6.4",
		"PG_CRON_SHA256":        "52d1850ee7beb85a4cb7185731ef4e5a90d1de216709d8988324b0d02e76af61",
		"SFCGAL_VERSION":        "1.4.1",
		"SFCGAL_SHA256":         "1800c8a26241588f11cddcf433049e9b9aea902e923414d2ecef33a3295626c3",
		"POSTGIS_14_16_VERSION": "3.3.3",
		"POSTGIS_14_16_SHA256":  "74eb356e3f85f14233791013360881b6748f78081cc688ff9d6f0f673a762d13",
		"POSTGIS_17_VERSION":    "3.5.0",
		"POSTGIS_17_SHA256":     "ca698a22cc2b2b3467ac4e063b43a28413f3004ddd505bdccdd74c56a647f510",
	}
	if got := extensionDockerArgs(m); !reflect.DeepEqual(got, want) {
		t.Fatalf("extensionDockerArgs() = %#v, want %#v", got, want)
	}
	if problems := checkDockerfileArgs(filepath.Join(root, dockerfilePath), want); len(problems) != 0 {
		t.Fatalf("Docker ARG drift: %v", problems)
	}
}

func TestCheckDockerfileArgs(t *testing.T) {
	want := map[string]string{
		"PG_CRON_VERSION": "1.6.4",
		"PG_CRON_SHA256":  strings.Repeat("a", 64),
	}

	t.Run("matching", func(t *testing.T) {
		path := writeDockerfile(t, "ARG PG_CRON_VERSION=1.6.4\nARG PG_CRON_SHA256="+strings.Repeat("a", 64)+"\n")
		if problems := checkDockerfileArgs(path, want); len(problems) != 0 {
			t.Fatalf("checkDockerfileArgs() = %v, want no problems", problems)
		}
	})

	t.Run("missing", func(t *testing.T) {
		path := writeDockerfile(t, "ARG PG_CRON_VERSION=1.6.4\n")
		problems := strings.Join(checkDockerfileArgs(path, want), "\n")
		if !strings.Contains(problems, "PG_CRON_SHA256") || !strings.Contains(problems, want["PG_CRON_SHA256"]) {
			t.Fatalf("problem %q does not name missing ARG and expected value", problems)
		}
	})

	t.Run("mismatch", func(t *testing.T) {
		path := writeDockerfile(t, "ARG PG_CRON_VERSION=9.9.9\nARG PG_CRON_SHA256="+strings.Repeat("a", 64)+"\n")
		problems := strings.Join(checkDockerfileArgs(path, want), "\n")
		if !strings.Contains(problems, "PG_CRON_VERSION") || !strings.Contains(problems, "9.9.9") || !strings.Contains(problems, "1.6.4") {
			t.Fatalf("problem %q does not describe ARG drift", problems)
		}
	})
}

func TestPromisedExtensionBuildScriptContract(t *testing.T) {
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(root, "docker", "neon-build", "build-promised-extensions.sh")
	scriptRaw, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	script := string(scriptRaw)
	for _, required := range []string{
		"set -Eeuo pipefail",
		"PG_CRON_VERSION", "PG_CRON_SHA256",
		"SFCGAL_VERSION", "SFCGAL_SHA256",
		"POSTGIS_14_16_VERSION", "POSTGIS_14_16_SHA256",
		"POSTGIS_17_VERSION", "POSTGIS_17_SHA256",
		`$install/bin/pg_config`,
		"oracle: neon compute/compute-node.Dockerfile",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("%s does not contain %q", scriptPath, required)
		}
	}

	dockerfileRaw, err := os.ReadFile(filepath.Join(root, dockerfilePath))
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(dockerfileRaw)
	copyNeedle := "COPY docker/neon-build/build-promised-extensions.sh /usr/local/bin/build-promised-extensions"
	runNeedle := "/usr/local/bin/build-promised-extensions /src/neon/pg_install"
	assembleNeedle := "cp -a pg_install/v14 pg_install/v15 pg_install/v16 pg_install/v17 /out/pg_install/"
	for _, needle := range []string{copyNeedle, runNeedle, assembleNeedle} {
		if !strings.Contains(dockerfile, needle) {
			t.Errorf("%s does not contain %q", dockerfilePath, needle)
		}
	}
	if runAt, assembleAt := strings.Index(dockerfile, runNeedle), strings.Index(dockerfile, assembleNeedle); runAt >= assembleAt {
		t.Errorf("extension build position = %d, output assembly position = %d; build must happen first", runAt, assembleAt)
	}
}

type verifierFixture struct {
	root    string
	fakeBin string
}

func newVerifierFixture(t *testing.T) verifierFixture {
	t.Helper()
	root := t.TempDir()
	fakeBin := filepath.Join(root, "fake-bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fakeBin, "ldd"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, major := range []string{"14", "15", "16", "17"} {
		install := filepath.Join(root, "v"+major)
		share := filepath.Join(install, "share", "extension")
		lib := filepath.Join(install, "lib")
		bin := filepath.Join(install, "bin")
		for _, dir := range []string{share, lib, bin} {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		pgConfig := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in --sharedir) echo %s/share ;; --pkglibdir) echo %s/lib ;; *) exit 2 ;; esac\n", install, install)
		if err := os.WriteFile(filepath.Join(bin, "pg_config"), []byte(pgConfig), 0o755); err != nil {
			t.Fatal(err)
		}
		postgisVersion := "3.3.3"
		if major == "17" {
			postgisVersion = "3.5.0"
		}
		controls := map[string]string{"pg_cron": "1.6", "vector": "0.8.0", "postgis": postgisVersion}
		for name, version := range controls {
			if err := os.WriteFile(filepath.Join(share, name+".control"), []byte("default_version = '"+version+"'\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(share, name+"--"+version+".sql"), []byte("-- fixture\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		for _, library := range []string{"pg_cron.so", "vector.so", "postgis-3.so"} {
			if err := os.WriteFile(filepath.Join(lib, library), []byte("fixture"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return verifierFixture{root: root, fakeBin: fakeBin}
}

func (f verifierFixture) run(t *testing.T) (string, error) {
	t.Helper()
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", filepath.Join(root, "docker", "verify-promised-extensions.sh"), f.root)
	cmd.Env = append(os.Environ(), "PATH="+f.fakeBin+":"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestPromisedExtensionVerifierAcceptsCompleteMatrix(t *testing.T) {
	f := newVerifierFixture(t)
	if out, err := f.run(t); err != nil {
		t.Fatalf("verifier failed: %v\n%s", err, out)
	}
}

func TestPromisedExtensionVerifierRejectsMissingCron(t *testing.T) {
	f := newVerifierFixture(t)
	if err := os.Remove(filepath.Join(f.root, "v16", "lib", "pg_cron.so")); err != nil {
		t.Fatal(err)
	}
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "pg_cron.so") {
		t.Fatalf("got err=%v output=%q", err, out)
	}
}

func TestPromisedExtensionVerifierRejectsWrongPostGISVersion(t *testing.T) {
	f := newVerifierFixture(t)
	control := filepath.Join(f.root, "v17", "share", "extension", "postgis.control")
	if err := os.WriteFile(control, []byte("default_version = '3.3.3'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "3.5.0") {
		t.Fatalf("got err=%v output=%q", err, out)
	}
}

func TestPromisedExtensionVerifierRejectsBrokenLinkage(t *testing.T) {
	f := newVerifierFixture(t)
	if err := os.WriteFile(filepath.Join(f.fakeBin, "ldd"), []byte("#!/bin/sh\necho 'libbroken.so => not found'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "unresolved") {
		t.Fatalf("got err=%v output=%q", err, out)
	}
}
