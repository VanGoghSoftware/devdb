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
	"regexp"
	"sort"
	"strings"
)

const (
	dockerfilePath        = "docker/neon-build/Dockerfile"
	manifestPath          = "docker/neon-build/versions.json"
	productDockerfilePath = "docker/Dockerfile"
	imagePrefix           = "worktreedb-neon-engine:local-"
	verifyScript          = "/usr/local/bin/verify-binaries.sh"
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

// sourceArchive is a checksum-pinned upstream source archive. SQLVersion is
// used only when the release tag and SQL extension version differ (pg_cron).
type sourceArchive struct {
	Version       string `json:"version"`
	SQLVersion    string `json:"sqlVersion"`
	Repo          string `json:"repo"`
	TarballURL    string `json:"tarballUrl"`
	TarballSha256 string `json:"tarballSha256"`
}

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
	PgCron  sourceArchive `json:"pgCron"`
	SFCGAL  sourceArchive `json:"sfcgal"`
	PostGIS struct {
		PG14To16 sourceArchive `json:"pg14To16"`
		PG17     sourceArchive `json:"pg17"`
	} `json:"postgis"`
	VanillaPostgres struct {
		Tag    string `json:"tag"`
		Commit string `json:"commit"`
	} `json:"vanillaPostgres"`
	Majors map[string]struct {
		Minor              int    `json:"minor"`
		PostgresForkCommit string `json:"postgresForkCommit"`
		SubmodulePath      string `json:"submodulePath"`
	} `json:"majors"`
	PublishedDigests struct {
		Images map[string]struct {
			Repo           string   `json:"repo"`
			Tags           []string `json:"tags"`
			ManifestDigest string   `json:"manifestDigest"`
		} `json:"images"`
	} `json:"publishedDigests"`
}

var wantMajors = []string{"14", "15", "16", "17"}

// wantImages is the set of published-image keys check-manifest expects under
// publishedDigests.images (sorted; "compute-*" < "engine" alphabetically).
var wantImages = []string{"compute-v14", "compute-v15", "compute-v16", "compute-v17", "engine"}

// manifestDigestRe matches a well-formed OCI manifest digest: sha256:<64 hex>.
var manifestDigestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// sourceSha256Re matches the bare sha256 checksums used for source archives.
var sourceSha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// dockerArgRe captures the controlled single-line `ARG NAME=value` form used
// by docker/neon-build/Dockerfile for source pins.
var dockerArgRe = regexp.MustCompile(`(?m)^ARG[ \t]+([A-Z0-9_]+)=([^ \t\r\n]+)[ \t]*$`)

// engineImageName is the GHCR image the product Dockerfile pins as its engine base;
// every engine FROM line must be pinned to publishedDigests.images.engine.manifestDigest.
const engineImageName = "worktreedb-neon-engine"

// engineRefRe matches each product Dockerfile FROM line that names the engine base image
// and captures its full image-reference token (registry path + `@digest` or `:tag`). It
// tolerates the Dockerfile forms that still name the same image — optional leading
// indentation, case-insensitive FROM, and FROM flags such as `--platform=...` — and the
// trailing whitespace/EOL boundary keeps the image name exact (so `worktreedb-neon-engine-foo`
// is NOT a match). Capturing the ref rather than only a well-formed digest means a stage that
// is tag-pinned or carries a malformed digest is still surfaced (as an un-pinned ref) instead
// of silently ignored. Limitation: FROM instructions split across physical lines with a
// trailing `\` continuation are not parsed. As the sole engine reference such a form fails
// loud ("no engine base line"); as a second stage behind an already-valid engine FROM it
// would be missed. Accepted by design — the product Dockerfile is a controlled, single-line-
// FROM file, so a drift gate over it does not warrant a continuation-preprocessing parser.
var engineRefRe = regexp.MustCompile(`(?m)^[ \t]*(?i:FROM)[ \t]+(?:--\S+[ \t]+)*(\S*/` + engineImageName + `(?:[@:]\S*)?)(?:[ \t\r]|$)`)

// checkEngineDigestPin verifies that EVERY engine base FROM line in the product Dockerfile
// at dfPath is pinned to exactly wantDigest (i.e. ends with `@<wantDigest>`). It returns a
// human-readable problem string, or "" when the Dockerfile has at least one engine FROM line
// and all of them are pinned to wantDigest.
func checkEngineDigestPin(dfPath, wantDigest string) string {
	dfRaw, err := os.ReadFile(dfPath)
	if err != nil {
		return fmt.Sprintf("cannot read %s for engine-digest cross-check: %v", dfPath, err)
	}
	refs := engineRefRe.FindAllSubmatch(dfRaw, -1)
	if len(refs) == 0 {
		return fmt.Sprintf("%s: found no `FROM .../%s@sha256:<digest>` engine base line", dfPath, engineImageName)
	}
	wantSuffix := "@" + wantDigest
	for _, m := range refs {
		ref := string(m[1])
		if !strings.HasSuffix(ref, wantSuffix) {
			return fmt.Sprintf("%s engine base %q is not pinned to publishedDigests.images.engine.manifestDigest %s", dfPath, ref, wantDigest)
		}
	}
	return ""
}

func extensionDockerArgs(m manifest) map[string]string {
	return map[string]string{
		"PG_CRON_VERSION":       m.PgCron.Version,
		"PG_CRON_SHA256":        m.PgCron.TarballSha256,
		"SFCGAL_VERSION":        m.SFCGAL.Version,
		"SFCGAL_SHA256":         m.SFCGAL.TarballSha256,
		"POSTGIS_14_16_VERSION": m.PostGIS.PG14To16.Version,
		"POSTGIS_14_16_SHA256":  m.PostGIS.PG14To16.TarballSha256,
		"POSTGIS_17_VERSION":    m.PostGIS.PG17.Version,
		"POSTGIS_17_SHA256":     m.PostGIS.PG17.TarballSha256,
	}
}

// checkDockerfileArgs verifies the manifest-to-Dockerfile duplication that is
// unavoidable because Docker cannot read versions.json while resolving ARGs.
func checkDockerfileArgs(dfPath string, want map[string]string) []string {
	raw, err := os.ReadFile(dfPath)
	if err != nil {
		return []string{fmt.Sprintf("cannot read %s for source-ARG cross-check: %v", dfPath, err)}
	}
	got := make(map[string]string)
	for _, match := range dockerArgRe.FindAllSubmatch(raw, -1) {
		got[string(match[1])] = string(match[2])
	}
	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	var problems []string
	for _, name := range names {
		value, ok := got[name]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s: missing ARG %s=%s", dfPath, name, want[name]))
			continue
		}
		if value != want[name] {
			problems = append(problems, fmt.Sprintf("%s: ARG %s=%s, want %s", dfPath, name, value, want[name]))
		}
	}
	return problems
}

func cmdCheckManifest(args []string) int {
	fs := flag.NewFlagSet("check-manifest", flag.ContinueOnError)
	path := fs.String("path", "", "path to versions.json (default: <repo-root>/"+manifestPath+")")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	// The repo root is always resolved: it defaults the manifest path (when --path is
	// unset) and locates the product Dockerfile for the engine-digest cross-check below,
	// so check-manifest must be run from within the repo tree.
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "check-manifest: %v\n", err)
		return 1
	}
	p := *path
	if p == "" {
		p = filepath.Join(root, manifestPath)
	}
	dfPath := filepath.Join(root, productDockerfilePath)

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
	for _, source := range []struct {
		name string
		pin  sourceArchive
	}{
		{name: "pgCron", pin: m.PgCron},
		{name: "sfcgal", pin: m.SFCGAL},
		{name: "postgis.pg14To16", pin: m.PostGIS.PG14To16},
		{name: "postgis.pg17", pin: m.PostGIS.PG17},
	} {
		req(source.name+".version", source.pin.Version)
		req(source.name+".repo", source.pin.Repo)
		req(source.name+".tarballUrl", source.pin.TarballURL)
		req(source.name+".tarballSha256", source.pin.TarballSha256)
		if source.pin.TarballSha256 != "" && !sourceSha256Re.MatchString(source.pin.TarballSha256) {
			problems = append(problems, fmt.Sprintf("%s.tarballSha256 %q is not 64 lowercase hex", source.name, source.pin.TarballSha256))
		}
	}
	req("pgCron.sqlVersion", m.PgCron.SQLVersion)
	req("vanillaPostgres.tag", m.VanillaPostgres.Tag)
	req("vanillaPostgres.commit", m.VanillaPostgres.Commit)

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

	// publishedDigests.images must be exactly {engine, compute-v14..17}, each with
	// a non-empty repo, at least one tag, and a well-formed sha256:<64hex> digest.
	gotImages := make([]string, 0, len(m.PublishedDigests.Images))
	for k := range m.PublishedDigests.Images {
		gotImages = append(gotImages, k)
	}
	sort.Strings(gotImages)
	if !equalStringSlices(gotImages, wantImages) {
		problems = append(problems, fmt.Sprintf("publishedDigests.images == %v, want %v", gotImages, wantImages))
	}
	for _, k := range wantImages {
		img, ok := m.PublishedDigests.Images[k]
		if !ok {
			continue // already reported by the set mismatch above
		}
		if strings.TrimSpace(img.Repo) == "" {
			problems = append(problems, fmt.Sprintf("publishedDigests.images[%s].repo is empty", k))
		}
		if len(img.Tags) == 0 {
			problems = append(problems, fmt.Sprintf("publishedDigests.images[%s].tags is empty", k))
		}
		if !manifestDigestRe.MatchString(img.ManifestDigest) {
			problems = append(problems, fmt.Sprintf("publishedDigests.images[%s].manifestDigest %q is not sha256:<64hex>", k, img.ManifestDigest))
		}
	}

	// Cross-check: the product Dockerfile must pin its engine base image to exactly
	// publishedDigests.images.engine.manifestDigest. The two digests are hand-synced and
	// nothing else enforces lockstep, so a publish that bumps versions.json but forgets to
	// repoint docker/Dockerfile (or vice-versa) would otherwise slip through. Skipped when
	// the engine digest is missing/malformed — already reported by the checks above.
	if eng, ok := m.PublishedDigests.Images["engine"]; ok && manifestDigestRe.MatchString(eng.ManifestDigest) {
		if prob := checkEngineDigestPin(dfPath, eng.ManifestDigest); prob != "" {
			problems = append(problems, prob)
		}
	}
	problems = append(problems, checkDockerfileArgs(filepath.Join(root, dockerfilePath), extensionDockerArgs(m))...)

	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "check-manifest: %s FAILED:\n", p)
		for _, pr := range problems {
			fmt.Fprintf(os.Stderr, "  - %s\n", pr)
		}
		return 1
	}

	fmt.Printf("check-manifest: OK — %s (neon %s, rust %s, pgvector %s, pg_cron %s, SFCGAL %s, PostGIS %s/%s, vanilla %s, majors %v, published %d images; source ARGs and %s engine FROM digest match)\n",
		p, m.NeonTag, m.Rust, m.Pgvector.Tag, m.PgCron.Version, m.SFCGAL.Version,
		m.PostGIS.PG14To16.Version, m.PostGIS.PG17.Version, m.VanillaPostgres.Tag,
		wantMajors, len(m.PublishedDigests.Images), productDockerfilePath)
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
