// Command worktreedb-build drives the from-source Neon engine build:
// building the multi-stage image for one architecture and running the
// binary-verification gate, plus a static validation of the source manifest.
//
// This is the first Go code of the DevDB -> Worktree DB rewrite (see
// docs/2026-07-06-rename-to-worktree-db-and-go-rewrite.md). It is intentionally
// stdlib-only (os/exec, flag, encoding/json) so it moves cleanly to the new
// worktreedb repo. The module path (github.com/VanGoghSoftware/worktreedb) is
// already the target path.
//
// Subcommands:
//
//	build --arch <amd64|arm64>   buildx-build the engine image + run verify-binaries.sh
//	check-manifest               statically validate docker/neon-build/versions.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	dockerfilePath = "docker/neon-build/Dockerfile"
	manifestPath   = "docker/neon-build/versions.json"
	imagePrefix    = "worktreedb-neon-engine:local-"
	verifyScript   = "/usr/local/bin/verify-binaries.sh"
)

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "build":
		os.Exit(cmdBuild(os.Args[2:]))
	case "check-manifest":
		os.Exit(cmdCheckManifest(os.Args[2:]))
	case "-h", "--help", "help":
		usage(os.Stdout)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "worktreedb-build: unknown subcommand %q\n\n", os.Args[1])
		usage(os.Stderr)
		os.Exit(2)
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `worktreedb-build — from-source Neon engine build driver

Usage:
  worktreedb-build build --arch <amd64|arm64>   build the engine image + run the verify gate
  worktreedb-build check-manifest               validate docker/neon-build/versions.json

Run from the repository root (the directory containing docker/neon-build/).
`)
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

func cmdBuild(args []string) int {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	arch := fs.String("arch", "", "target architecture: amd64 or arm64")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	switch *arch {
	case "amd64", "arm64":
		// ok
	case "":
		fmt.Fprintln(os.Stderr, "build: --arch is required (amd64 or arm64)")
		return 2
	default:
		fmt.Fprintf(os.Stderr, "build: unsupported --arch %q (want amd64 or arm64)\n", *arch)
		return 2
	}

	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n", err)
		return 1
	}
	tag := imagePrefix + *arch

	// docker buildx build --platform linux/<arch> -f <dockerfile> -t <tag> --load .
	buildArgs := []string{
		"buildx", "build",
		"--platform", "linux/" + *arch,
		"-f", dockerfilePath,
		"-t", tag,
		"--load",
		".",
	}
	if err := run(root, "docker", buildArgs...); err != nil {
		fmt.Fprintf(os.Stderr, "build: image build failed: %v\n", err)
		return 1
	}

	// docker run --rm <tag> bash /usr/local/bin/verify-binaries.sh
	if err := run(root, "docker", "run", "--rm", tag, "bash", verifyScript); err != nil {
		fmt.Fprintf(os.Stderr, "build: verify-binaries failed: %v\n", err)
		return 1
	}

	fmt.Printf("build: OK — %s built and verified\n", tag)
	return 0
}

// ---------------------------------------------------------------------------
// check-manifest
// ---------------------------------------------------------------------------

// manifest mirrors the fields of versions.json that this validator checks.
// Unknown fields are ignored; missing required fields fail validation.
type manifest struct {
	NeonTag    string `json:"neonTag"`
	NeonCommit string `json:"neonCommit"`
	Rust       string `json:"rust"`
	Pgvector   struct {
		Tag           string `json:"tag"`
		TarballURL    string `json:"tarballUrl"`
		TarballSha256 string `json:"tarballSha256"`
	} `json:"pgvector"`
	Majors map[string]struct {
		Minor              int    `json:"minor"`
		PostgresForkCommit string `json:"postgresForkCommit"`
		SubmodulePath      string `json:"submodulePath"`
	} `json:"majors"`
}

var wantMajors = []string{"14", "15", "16", "17"}

func cmdCheckManifest(args []string) int {
	fs := flag.NewFlagSet("check-manifest", flag.ContinueOnError)
	path := fs.String("path", "", "path to versions.json (default: <repo-root>/"+manifestPath+")")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	p := *path
	if p == "" {
		root, err := repoRoot()
		if err != nil {
			fmt.Fprintf(os.Stderr, "check-manifest: %v\n", err)
			return 1
		}
		p = filepath.Join(root, manifestPath)
	}

	raw, err := os.ReadFile(p)
	if err != nil {
		fmt.Fprintf(os.Stderr, "check-manifest: %v\n", err)
		return 1
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		fmt.Fprintf(os.Stderr, "check-manifest: %s: invalid JSON: %v\n", p, err)
		return 1
	}

	var problems []string
	req := func(name, val string) {
		if strings.TrimSpace(val) == "" {
			problems = append(problems, "missing "+name)
		}
	}
	req("neonTag", m.NeonTag)
	req("neonCommit", m.NeonCommit)
	req("rust", m.Rust)
	req("pgvector.tag", m.Pgvector.Tag)
	req("pgvector.tarballUrl", m.Pgvector.TarballURL)
	req("pgvector.tarballSha256", m.Pgvector.TarballSha256)

	// majors must be exactly {14,15,16,17}, each with a resolvable fork commit.
	got := make([]string, 0, len(m.Majors))
	for k := range m.Majors {
		got = append(got, k)
	}
	sort.Strings(got)
	if !equalStringSlices(got, wantMajors) {
		problems = append(problems, fmt.Sprintf("majors == %v, want %v", got, wantMajors))
	}
	for _, k := range wantMajors {
		mj, ok := m.Majors[k]
		if !ok {
			continue // already reported by the set mismatch above
		}
		if strings.TrimSpace(mj.PostgresForkCommit) == "" {
			problems = append(problems, fmt.Sprintf("majors[%s].postgresForkCommit is empty", k))
		}
		if mj.Minor <= 0 {
			problems = append(problems, fmt.Sprintf("majors[%s].minor must be > 0", k))
		}
	}

	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "check-manifest: %s FAILED:\n", p)
		for _, pr := range problems {
			fmt.Fprintf(os.Stderr, "  - %s\n", pr)
		}
		return 1
	}

	fmt.Printf("check-manifest: OK — %s (neon %s, rust %s, pgvector %s, majors %v)\n",
		p, m.NeonTag, m.Rust, m.Pgvector.Tag, wantMajors)
	return 0
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// repoRoot returns the directory that contains docker/neon-build/, searching
// from the current working directory upward. This lets the CLI be invoked from
// the repo root (the common case) or a subdirectory.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if fi, err := os.Stat(filepath.Join(dir, dockerfilePath)); err == nil && !fi.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not locate %s from the current directory or any parent", dockerfilePath)
		}
		dir = parent
	}
}

// run executes name+args in dir, streaming child stdio to the parent.
func run(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	fmt.Fprintf(os.Stderr, "+ %s %s\n", name, strings.Join(args, " "))
	return cmd.Run()
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
