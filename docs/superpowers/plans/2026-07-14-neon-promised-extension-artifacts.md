# Neon Promised Extension Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish native amd64/arm64 Neon engine and PostgreSQL 14–17 carrier images that contain pg_cron, pgvector, and PostGIS, then repin Worktree DB and remove its duplicate extension compilation layer.

**Architecture:** `devdb` remains the sole artifact producer: one Bookworm source build installs the promised extensions into each exact Neon PostgreSQL tree before both the engine image and per-major carriers copy it. Worktree DB remains the capability-enforcing consumer: it pins the published engine digest, validates the final runtime filesystem, and rejects any downloaded candidate that fails the existing live extension gate.

**Tech Stack:** Docker BuildKit, Debian Bookworm, Bash, Go standard library tests, PostgreSQL PGXS 14–17, pg_cron 1.6.4, pgvector 0.8.0, PostGIS 3.3.3/3.5.0, SFCGAL 1.4.1, GitHub Actions, GHCR multi-architecture manifests.

## Global Constraints

- Keep the Neon producer, source manifest, GHCR workflow, and carrier images in `devdb`; do not create a second producer in Worktree DB.
- Keep Worktree DB changes on its current checkout/branch. Do not create another Worktree DB feature branch or worktree.
- Preserve unrelated user changes in both repositories. Stage only exact task files.
- Use pinned source versions and SHA-256 checksums; no floating downloads.
- Build every C/C++ extension against that major's own `bin/pg_config`.
- Keep `vanilla_v17` extension-free; it is the true-upstream storage-controller catalog host, not a compute.
- Every Neon-derived build/config use site carries `# oracle: neon <path-or-endpoint>` or `// oracle: neon <path-or-endpoint>`.
- TDD is mandatory. Record each RED command/output before implementing its GREEN change.
- Do not file upstream issues, pull requests, or comments.
- Use conventional commits without co-author trailers.
- Do not repin Worktree DB until the published amd64/arm64 manifest has been inspected and the immutable digest recorded.
- Preserve explicit database extension creation; never auto-run `CREATE EXTENSION` or `ALTER EXTENSION UPDATE` in user databases.

## File Map

### `devdb` producer worktree

- `cmd/worktreedb-build/main.go` — parse and validate promised-extension source pins and their Docker ARG copies.
- `cmd/worktreedb-build/main_test.go` — hermetic manifest, Docker ARG, verifier-fixture, and workflow trigger tests.
- `docker/neon-build/versions.json` — authoritative source pins and published manifest digests.
- `docker/neon-build/Dockerfile` — build dependencies, extension ARGs, per-major compilation, and engine runtime libraries.
- `docker/neon-build/build-promised-extensions.sh` — checksum downloads plus pg_cron/SFCGAL/PostGIS builds.
- `docker/verify-promised-extensions.sh` — structural, version, and `ldd` contract shared by producer verification.
- `docker/verify-binaries.sh` — invoke the promised-extension verifier after core engine checks.
- `docker/Dockerfile` — legacy product consumer digest and PostGIS runtime libraries.
- `.github/workflows/build-neon-engine.yml` — trigger on both new verifier/build scripts and retain native pre-push verification.
- `docker/neon-build/README.md` — producer artifact contents and build behavior.
- `docker/BINARIES.md` — source/license inventory and final published digests.

### Worktree DB current checkout

- `Dockerfile` — repin engine digest, remove compiler stage, retain runtime verifier and libraries.
- `build/extensions/build-promised-extensions.sh` — delete after producer cutover.
- `build/extensions/verify-promised-extensions.sh` — retain as the final product-filesystem tripwire.
- `docs/architecture.md` — describe producer ownership instead of outer-image compilation.
- `docs/superpowers/specs/2026-07-14-extension-support-design.md` — append the artifact-producer cutover amendment.

---

### Task 1: Pin and validate extension sources

**Files:**
- Modify: `cmd/worktreedb-build/main.go`
- Modify: `cmd/worktreedb-build/main_test.go`
- Modify: `docker/neon-build/versions.json`
- Modify: `docker/neon-build/Dockerfile`

**Interfaces:**
- Consumes: the existing `manifest` JSON model and `cmdCheckManifest` gate.
- Produces: `extensionDockerArgs(m manifest) map[string]string` and `checkDockerfileArgs(path string, want map[string]string) []string`; manifest fields `pgCron`, `sfcgal`, and `postgis.pg14To16/pg17`.

- [ ] **Step 1: Add failing manifest and Docker ARG tests**

Add tests that decode the real manifest and require the exact release contract:

```go
func TestPromisedExtensionPins(t *testing.T) {
	root, err := repoRoot()
	if err != nil { t.Fatal(err) }
	raw, err := os.ReadFile(filepath.Join(root, manifestPath))
	if err != nil { t.Fatal(err) }
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil { t.Fatal(err) }
	want := map[string]string{
		"PG_CRON_VERSION": "1.6.4",
		"PG_CRON_SHA256": "52d1850ee7beb85a4cb7185731ef4e5a90d1de216709d8988324b0d02e76af61",
		"SFCGAL_VERSION": "1.4.1",
		"SFCGAL_SHA256": "1800c8a26241588f11cddcf433049e9b9aea902e923414d2ecef33a3295626c3",
		"POSTGIS_14_16_VERSION": "3.3.3",
		"POSTGIS_14_16_SHA256": "74eb356e3f85f14233791013360881b6748f78081cc688ff9d6f0f673a762d13",
		"POSTGIS_17_VERSION": "3.5.0",
		"POSTGIS_17_SHA256": "ca698a22cc2b2b3467ac4e063b43a28413f3004ddd505bdccdd74c56a647f510",
	}
	if got := extensionDockerArgs(m); !reflect.DeepEqual(got, want) {
		t.Fatalf("extensionDockerArgs() = %#v, want %#v", got, want)
	}
	if problems := checkDockerfileArgs(filepath.Join(root, dockerfilePath), want); len(problems) != 0 {
		t.Fatalf("Docker ARG drift: %v", problems)
	}
}
```

Add a table test with a temporary Dockerfile that covers a missing ARG and a mismatched ARG; require the problem to name the ARG and expected value.

- [ ] **Step 2: Run the focused test and capture RED**

Run: `go test ./cmd/worktreedb-build -run 'TestPromisedExtensionPins|TestCheckDockerfileArgs' -count=1 -v`

Expected: FAIL to compile because the manifest fields and helper functions do not exist.

- [ ] **Step 3: Add the manifest model and validation helpers**

Add a reusable source model and the three fields:

```go
type sourceArchive struct {
	Version       string `json:"version"`
	SQLVersion    string `json:"sqlVersion"`
	Repo          string `json:"repo"`
	TarballURL    string `json:"tarballUrl"`
	TarballSha256 string `json:"tarballSha256"`
}

type manifest struct {
	// existing fields remain unchanged
	PgCron sourceArchive `json:"pgCron"`
	SFCGAL sourceArchive `json:"sfcgal"`
	PostGIS struct {
		PG14To16 sourceArchive `json:"pg14To16"`
		PG17     sourceArchive `json:"pg17"`
	} `json:"postgis"`
}
```

`extensionDockerArgs` maps the eight exact ARG names from those fields. `checkDockerfileArgs` scans `^ARG NAME=value$`, reports missing/mismatched values, and `cmdCheckManifest` appends those problems after requiring every URL, repository, version, and 64-hex checksum.

- [ ] **Step 4: Add authoritative JSON pins and Docker ARG copies**

Add `pgCron`, `sfcgal`, and `postgis` objects to `versions.json` with the exact values in Step 1 and these URLs:

```text
https://github.com/citusdata/pg_cron/archive/refs/tags/v1.6.4.tar.gz
https://gitlab.com/sfcgal/SFCGAL/-/archive/v1.4.1/SFCGAL-v1.4.1.tar.gz
https://download.osgeo.org/postgis/source/postgis-3.3.3.tar.gz
https://download.osgeo.org/postgis/source/postgis-3.5.0.tar.gz
```

Add the eight matching `ARG` instructions beside the pgvector pins in the producer Dockerfile. Cite `# oracle: neon compute/compute-node.Dockerfile (pg_cron-src, postgis-src, postgis-build)` above them.

- [ ] **Step 5: Run GREEN verification**

Run:

```bash
go test ./cmd/worktreedb-build -count=1
go run ./cmd/worktreedb-build check-manifest
```

Expected: PASS; check-manifest names pg_cron 1.6.4, SFCGAL 1.4.1, and both PostGIS releases in its success output.

- [ ] **Step 6: Commit**

```bash
git add cmd/worktreedb-build/main.go cmd/worktreedb-build/main_test.go docker/neon-build/versions.json docker/neon-build/Dockerfile
git commit -m "build: pin promised extension sources"
```

---

### Task 2: Compile extensions into the shared PostgreSQL output trees

**Files:**
- Create: `docker/neon-build/build-promised-extensions.sh`
- Modify: `docker/neon-build/Dockerfile`
- Modify: `cmd/worktreedb-build/main_test.go`

**Interfaces:**
- Consumes: the eight Docker ARG values and `/src/neon/pg_install/v14..v17`.
- Produces: pg_cron and PostGIS files installed into each input tree before `/out/pg_install` is assembled.

- [ ] **Step 1: Add a failing build-script contract test**

Add `TestPromisedExtensionBuildScriptContract`. Read the future script and require all of:

```go
want := []string{
	"set -Eeuo pipefail",
	"PG_CRON_VERSION", "PG_CRON_SHA256",
	"SFCGAL_VERSION", "SFCGAL_SHA256",
	"POSTGIS_14_16_VERSION", "POSTGIS_14_16_SHA256",
	"POSTGIS_17_VERSION", "POSTGIS_17_SHA256",
	"$install/bin/pg_config",
	"oracle: neon compute/compute-node.Dockerfile",
}
```

Also require the producer Dockerfile to copy the script and invoke it before `cp -a pg_install/v14 ... /out/pg_install/`.

- [ ] **Step 2: Run the test and capture RED**

Run: `go test ./cmd/worktreedb-build -run TestPromisedExtensionBuildScriptContract -count=1 -v`

Expected: FAIL because `docker/neon-build/build-promised-extensions.sh` does not exist.

- [ ] **Step 3: Implement the pinned build script**

Port the proven Worktree DB build algorithm into the producer script. Require one argument (`<pg-install-root>`) and all eight environment variables. Implement:

```bash
download() {
  local url=$1 sha256=$2 output=$3
  curl --fail --location --retry 5 --retry-all-errors --output "$output" "$url"
  printf '%s  %s\n' "$sha256" "$output" | sha256sum --check
}
```

Build SFCGAL once with Ninja and `--parallel "${EXTENSION_JOBS:-2}"`. Loop `v14` through `v17`; require each exact tree, derive its `pg_config`, extract a fresh pg_cron and matching PostGIS source, build/install with that `pg_config`, and append `trusted = true` only when absent. Use PostGIS 3.3.3 for 14–16 and 3.5.0 for 17. Fail on every unknown or missing major.

- [ ] **Step 4: Wire build dependencies and invocation into the producer Dockerfile**

Extend `build-tools` apt packages with the exact Bookworm build set already proven in Worktree DB:

```text
autoconf automake g++ libtool ninja-build
libboost-dev libboost-filesystem-dev libboost-iostreams-dev
libboost-program-options-dev libboost-system-dev libboost-thread-dev libboost-timer-dev
libcgal-dev libgdal-dev libgeos-dev libgmp-dev libjson-c-dev libmpfr-dev
libopenscenegraph-dev libpcre2-dev libproj-dev libprotobuf-c-dev
libxslt1-dev protobuf-c-compiler xsltproc
```

After pgvector and before output assembly:

```dockerfile
COPY docker/neon-build/build-promised-extensions.sh /usr/local/bin/build-promised-extensions
RUN chmod +x /usr/local/bin/build-promised-extensions \
    && PG_CRON_VERSION="$PG_CRON_VERSION" PG_CRON_SHA256="$PG_CRON_SHA256" \
       SFCGAL_VERSION="$SFCGAL_VERSION" SFCGAL_SHA256="$SFCGAL_SHA256" \
       POSTGIS_14_16_VERSION="$POSTGIS_14_16_VERSION" POSTGIS_14_16_SHA256="$POSTGIS_14_16_SHA256" \
       POSTGIS_17_VERSION="$POSTGIS_17_VERSION" POSTGIS_17_SHA256="$POSTGIS_17_SHA256" \
       EXTENSION_JOBS=2 /usr/local/bin/build-promised-extensions /src/neon/pg_install
```

- [ ] **Step 5: Run syntax and contract GREEN tests**

Run:

```bash
bash -n docker/neon-build/build-promised-extensions.sh
go test ./cmd/worktreedb-build -run 'TestPromisedExtensionBuildScriptContract|TestPromisedExtensionPins' -count=1 -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docker/neon-build/build-promised-extensions.sh docker/neon-build/Dockerfile cmd/worktreedb-build/main_test.go
git commit -m "build: compile promised extensions in neon artifacts"
```

---

### Task 3: Enforce the artifact and runtime-linkage contract

**Files:**
- Create: `docker/verify-promised-extensions.sh`
- Modify: `docker/verify-binaries.sh`
- Modify: `docker/neon-build/Dockerfile`
- Modify: `docker/Dockerfile`
- Modify: `cmd/worktreedb-build/main_test.go`

**Interfaces:**
- Consumes: `<pg-install-root>` containing exactly `v14..v17`.
- Produces: `verify-promised-extensions.sh <pg-install-root>`, exiting nonzero for a missing artifact, wrong default version, unexpected major, or unresolved library.

- [ ] **Step 1: Add failing hermetic verifier tests**

Create a Go fixture that writes four fake installs. Each fake `bin/pg_config` prints its fixture `share` or `lib` path for `--sharedir`/`--pkglibdir`; create controls, SQL files, and `.so` placeholders. Put a fake `ldd` executable first on `PATH` that exits zero.

Add this fixture API and the four assertions (the helper writes the controls,
one SQL file per extension, `.so` placeholders, executable `pg_config`, and a
fake successful `ldd` exactly as described above):

```go
type verifierFixture struct {
	root    string
	fakeBin string
}

func newVerifierFixture(t *testing.T) verifierFixture {
	t.Helper()
	root := t.TempDir()
	fakeBin := filepath.Join(root, "fake-bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(fakeBin, "ldd"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil { t.Fatal(err) }
	for _, major := range []string{"14", "15", "16", "17"} {
		install := filepath.Join(root, "v"+major)
		share := filepath.Join(install, "share", "extension")
		lib := filepath.Join(install, "lib")
		bin := filepath.Join(install, "bin")
		for _, dir := range []string{share, lib, bin} {
			if err := os.MkdirAll(dir, 0o755); err != nil { t.Fatal(err) }
		}
		pgConfig := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in --sharedir) echo %s/share ;; --pkglibdir) echo %s/lib ;; *) exit 2 ;; esac\n", install, install)
		if err := os.WriteFile(filepath.Join(bin, "pg_config"), []byte(pgConfig), 0o755); err != nil { t.Fatal(err) }
		postgisVersion := "3.3.3"
		if major == "17" { postgisVersion = "3.5.0" }
		controls := map[string]string{"pg_cron": "1.6", "vector": "0.8.0", "postgis": postgisVersion}
		for name, version := range controls {
			if err := os.WriteFile(filepath.Join(share, name+".control"), []byte("default_version = '"+version+"'\n"), 0o644); err != nil { t.Fatal(err) }
			if err := os.WriteFile(filepath.Join(share, name+"--"+version+".sql"), []byte("-- fixture\n"), 0o644); err != nil { t.Fatal(err) }
		}
		for _, library := range []string{"pg_cron.so", "vector.so", "postgis-3.so"} {
			if err := os.WriteFile(filepath.Join(lib, library), []byte("fixture"), 0o644); err != nil { t.Fatal(err) }
		}
	}
	return verifierFixture{root: root, fakeBin: fakeBin}
}

func (f verifierFixture) run(t *testing.T) (string, error) {
	t.Helper()
	root, err := repoRoot()
	if err != nil { t.Fatal(err) }
	cmd := exec.Command("bash", filepath.Join(root, "docker", "verify-promised-extensions.sh"), f.root)
	cmd.Env = append(os.Environ(), "PATH="+f.fakeBin+":"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestPromisedExtensionVerifierAcceptsCompleteMatrix(t *testing.T) {
	f := newVerifierFixture(t)
	if out, err := f.run(t); err != nil { t.Fatalf("verifier failed: %v\n%s", err, out) }
}

func TestPromisedExtensionVerifierRejectsMissingCron(t *testing.T) {
	f := newVerifierFixture(t)
	if err := os.Remove(filepath.Join(f.root, "v16", "lib", "pg_cron.so")); err != nil { t.Fatal(err) }
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "pg_cron.so") { t.Fatalf("got err=%v output=%q", err, out) }
}

func TestPromisedExtensionVerifierRejectsWrongPostGISVersion(t *testing.T) {
	f := newVerifierFixture(t)
	control := filepath.Join(f.root, "v17", "share", "extension", "postgis.control")
	if err := os.WriteFile(control, []byte("default_version = '3.3.3'\n"), 0o644); err != nil { t.Fatal(err) }
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "3.5.0") { t.Fatalf("got err=%v output=%q", err, out) }
}

func TestPromisedExtensionVerifierRejectsBrokenLinkage(t *testing.T) {
	f := newVerifierFixture(t)
	if err := os.WriteFile(filepath.Join(f.fakeBin, "ldd"), []byte("#!/bin/sh\necho 'libbroken.so => not found'\n"), 0o755); err != nil { t.Fatal(err) }
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "unresolved") { t.Fatalf("got err=%v output=%q", err, out) }
}
```

- [ ] **Step 2: Run the tests and capture RED**

Run: `go test ./cmd/worktreedb-build -run TestPromisedExtensionVerifier -count=1 -v`

Expected: FAIL because `docker/verify-promised-extensions.sh` does not exist.

- [ ] **Step 3: Implement the verifier**

For every discovered `v[0-9]*`, require majors 14–17 only, executable `pg_config`, these artifacts, and the exact control default version:

```text
pg_cron.control / pg_cron--*.sql / pg_cron.so / default_version 1.6
vector.control  / vector--*.sql  / vector.so  / default_version 0.8.0
postgis.control / postgis--*.sql / postgis-3.so / default_version 3.3.3 (14–16) or 3.5.0 (17)
```

Run `ldd` on pg_cron, vector, and every `postgis*.so`; fail on command error or `not found`. Separately require that all four majors were seen.

- [ ] **Step 4: Wire the verifier into producer images and runtime packages**

At the end of `docker/verify-binaries.sh`, invoke:

```bash
/usr/local/bin/verify-promised-extensions "$PG"
```

Copy the verifier into the producer final stage. Extend both producer runtime apt lists (`docker/neon-build/Dockerfile` and legacy `docker/Dockerfile`) with:

```text
libgdal32 libgeos-c1v5 libproj25 libprotobuf-c1 libsfcgal1 libxslt1.1
```

The carrier stages stay `FROM scratch`; they inherit extension artifacts through `/out` and no OS root.

- [ ] **Step 5: Run GREEN verification**

Run:

```bash
bash -n docker/verify-promised-extensions.sh docker/verify-binaries.sh
go test ./cmd/worktreedb-build -run TestPromisedExtensionVerifier -count=1 -v
go test ./cmd/worktreedb-build -count=1
go run ./cmd/worktreedb-build check-manifest
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docker/verify-promised-extensions.sh docker/verify-binaries.sh docker/neon-build/Dockerfile docker/Dockerfile cmd/worktreedb-build/main_test.go
git commit -m "test: verify promised extension artifacts"
```

---

### Task 4: Make pipeline triggers and producer documentation complete

**Files:**
- Modify: `.github/workflows/build-neon-engine.yml`
- Modify: `cmd/worktreedb-build/main_test.go`
- Modify: `docker/neon-build/README.md`
- Modify: `docker/BINARIES.md`

**Interfaces:**
- Consumes: the new producer scripts and version matrix.
- Produces: path-trigger coverage and an auditable source/license inventory.

- [ ] **Step 1: Add a failing workflow trigger test**

Read `.github/workflows/build-neon-engine.yml` and require both paths:

```go
for _, path := range []string{
	"docker/neon-build/build-promised-extensions.sh",
	"docker/verify-promised-extensions.sh",
} {
	if !strings.Contains(workflow, "- "+path) { t.Errorf("workflow does not trigger on %s", path) }
}
```

- [ ] **Step 2: Run the test and capture RED**

Run: `go test ./cmd/worktreedb-build -run TestBuildWorkflowTracksExtensionScripts -count=1 -v`

Expected: FAIL naming both missing workflow paths.

- [ ] **Step 3: Add both path triggers**

Add both paths under `on.push.paths`. Keep the existing native per-architecture verifier before every push-by-digest step and the merge job's dependency on both matrix legs.

- [ ] **Step 4: Update producer documentation**

Update `docker/neon-build/README.md` to list all three promised extensions in the engine and carriers. Update `docker/BINARIES.md` source and license tables:

```text
pg_cron 1.6.4 — PostgreSQL License — citusdata/pg_cron
pgvector 0.8.0 — PostgreSQL License — pgvector/pgvector
PostGIS 3.3.3/3.5.0 — GPL-2.0-or-later — postgis/postgis
SFCGAL 1.4.1 — LGPL-2.0-or-later — SFCGAL/SFCGAL
```

State that the carriers now guarantee pg_cron/vector/PostGIS but rely on the consuming Bookworm runtime for native shared libraries.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
go test ./cmd/worktreedb-build -run TestBuildWorkflowTracksExtensionScripts -count=1 -v
go test ./...
go vet ./...
go run ./cmd/worktreedb-build check-manifest
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/build-neon-engine.yml cmd/worktreedb-build/main_test.go docker/neon-build/README.md docker/BINARIES.md
git commit -m "docs: document extension-complete neon artifacts"
```

---

### Task 5: Publish and verify the native multi-architecture artifacts

**Files:**
- No source edits before the workflow succeeds.

**Interfaces:**
- Consumes: `codex/neon-promised-extensions` and `build-neon-engine.yml`.
- Produces: five inspected multi-architecture manifest digests: engine plus compute-v14..v17.

- [ ] **Step 1: Run the complete local producer gate**

Run:

```bash
go build ./...
go vet ./...
go test ./... -count=1
go run ./cmd/worktreedb-build check-manifest
bash -n docker/neon-build/build-promised-extensions.sh docker/verify-promised-extensions.sh docker/verify-binaries.sh
git diff --check
git status --short
```

Expected: all commands exit zero; status contains only committed branch history.

- [ ] **Step 2: Push the producer branch**

Run: `git push -u origin codex/neon-promised-extensions`

Expected: branch push succeeds without altering `devdb`'s dirty main checkout.

- [ ] **Step 3: Dispatch the exact branch and identify the run**

Run:

```bash
gh workflow run build-neon-engine.yml --ref codex/neon-promised-extensions
RUN_ID="$(gh run list --workflow build-neon-engine.yml --branch codex/neon-promised-extensions --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run view "$RUN_ID"
```

The final command must show the newly queued branch-dispatch run.

- [ ] **Step 4: Wait for the release gate**

Run: `gh run watch "$RUN_ID" --exit-status`

Expected: both native build legs and the merge job succeed. If a leg fails, inspect with `gh run view "$RUN_ID" --log-failed`, fix via a new RED/GREEN cycle, push, and dispatch a new run; never continue from a failed run.

- [ ] **Step 5: Inspect every published manifest**

Run `docker buildx imagetools inspect` for:

```text
ghcr.io/vangoghsoftware/worktreedb-neon-engine:release-9129
ghcr.io/vangoghsoftware/worktreedb-compute-v14:14.18
ghcr.io/vangoghsoftware/worktreedb-compute-v15:15.13
ghcr.io/vangoghsoftware/worktreedb-compute-v16:16.9
ghcr.io/vangoghsoftware/worktreedb-compute-v17:17.5
```

Expected: each output has one immutable `sha256:` manifest-list digest and child manifests for both `linux/amd64` and `linux/arm64`. Save the five digest values and workflow run ID for Task 6.

---

### Task 6: Record the immutable release and prepare the consumer cutover

**Files:**
- Modify: `docker/neon-build/versions.json`
- Modify: `docker/BINARIES.md`
- Modify: `docker/Dockerfile`

**Interfaces:**
- Consumes: the successful Task 5 workflow run ID and five manifest-list digests.
- Produces: a self-consistent producer release record and legacy consumer engine pin.

- [ ] **Step 1: Record all release metadata**

Update `publishedDigests.workflowRun`, `sourceCommit`, `publishedAt`, and all five `manifestDigest` fields. Replace the engine digest in `docker/Dockerfile` with the new engine manifest digest. Update `docker/BINARIES.md`'s published-image table and inventory narrative.

- [ ] **Step 2: Run manifest RED before synchronizing the Dockerfile pin**

Perform the JSON digest edit first, then run: `go run ./cmd/worktreedb-build check-manifest`

Expected: FAIL because `docker/Dockerfile` still pins the previous engine digest. Capture this as the release-record cross-check RED.

- [ ] **Step 3: Synchronize the Dockerfile pin and run GREEN**

Apply the engine `FROM` digest edit and run:

```bash
go run ./cmd/worktreedb-build check-manifest
go test ./... -count=1
go vet ./...
git diff --check
```

Expected: PASS and the success line names the new engine digest match.

- [ ] **Step 4: Commit and push the release record without triggering a duplicate build**

```bash
git add docker/neon-build/versions.json docker/BINARIES.md docker/Dockerfile
git commit -m "chore: record promised extension image digests [skip ci]"
git push origin codex/neon-promised-extensions
```

Expected: branch head contains the immutable release record; no push-triggered workflow runs because the head commit carries `[skip ci]`.

---

### Task 7: Repin and simplify Worktree DB on its current branch

**Files:**
- Modify: `Dockerfile`
- Delete: `build/extensions/build-promised-extensions.sh`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-14-extension-support-design.md`

**Interfaces:**
- Consumes: the new engine manifest digest and its complete `/usr/local/share/neon` tree.
- Produces: a Worktree DB image that copies producer artifacts directly and still verifies them in the final runtime filesystem.

- [ ] **Step 1: Confirm repository safety and current branch**

Run:

```bash
git branch --show-current
git status --short --branch
```

Expected: remain on the user's current Worktree DB checkout; `.idea/`, `docs/backlog.md`, and `docs/custom-postgres-extensions.md` remain untouched and untracked.

- [ ] **Step 2: Prove the new engine artifact directly**

Pull the engine by its immutable digest, then run its own verifier:

```bash
ENGINE_DIGEST="$(jq -r '.publishedDigests.images.engine.manifestDigest' /Users/jordan/git/worktreedb/.worktrees/devdb-neon-promised-extensions/docker/neon-build/versions.json)"
test -n "$ENGINE_DIGEST"
ENGINE_REF="ghcr.io/vangoghsoftware/worktreedb-neon-engine@$ENGINE_DIGEST"
docker pull "$ENGINE_REF"
docker run --rm "$ENGINE_REF" bash /usr/local/bin/verify-binaries.sh
```

Expected: PASS with one promised-extension success line for each PostgreSQL major.

- [ ] **Step 3: Replace the outer compilation stage**

Change the first `FROM` digest. Remove the entire `promised-extensions` compiler stage and its build-only apt packages. In the final stage use:

```dockerfile
COPY --from=neon-binaries /usr/local/share/neon /usr/local/share/neon
COPY build/extensions/verify-promised-extensions.sh /tmp/verify-promised-extensions
RUN /tmp/verify-promised-extensions /usr/local/share/neon/pg_install \
    && rm /tmp/verify-promised-extensions
```

Retain the final runtime packages `libgdal32 libgeos-c1v5 libproj25 libprotobuf-c1 libsfcgal1 libxslt1.1`, the client-binary tripwire, and all daemon configuration.

- [ ] **Step 4: Delete only the obsolete source builder**

Delete `build/extensions/build-promised-extensions.sh`. Keep `build/extensions/verify-promised-extensions.sh` unchanged unless the producer's exact version validation requires bringing the final-image tripwire to parity.

- [ ] **Step 5: Amend architecture documentation**

Change `docs/architecture.md` to state that pg_cron, pgvector, and PostGIS are compiled by the `devdb` Neon producer against each exact `pg_config`, included in both baked and carrier artifacts, and revalidated by Worktree DB.

Append an amendment to the historical extension design explaining that the planned “future build optimization” is now implemented by the digest-pinned producer, without changing runtime behavior or the promised matrix.

- [ ] **Step 6: Run non-container GREEN gates**

Run:

```bash
go build ./...
go vet ./...
go test ./... -count=1
golangci-lint run
(cd web && pnpm test && pnpm build)
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Build the simplified product image**

Run: `docker build --progress=plain -t worktreedb:producer-extensions .`

Expected: PASS; output shows the retained final-filesystem extension verifier but no pg_cron/PostGIS source compilation.

- [ ] **Step 8: Run the real extension and restore regressions**

Run:

```bash
WORKTREEDB_TEST_IMAGE=worktreedb:producer-extensions go test -tags integration ./integration/... -run 'TestPromisedExtensionsAllMajors|TestPromisedExtensionsPG16Restore' -v -timeout 20m -count=1
```

Expected: PASS for PG14, PG15, PG16, PG17, and the PG16 extension dump restore.

- [ ] **Step 9: Commit exact Worktree DB files**

```bash
git add Dockerfile build/extensions/build-promised-extensions.sh docs/architecture.md docs/superpowers/specs/2026-07-14-extension-support-design.md
git commit -m "build: consume extension-complete neon artifacts"
```

Do not stage `.idea/`, `docs/backlog.md`, or `docs/custom-postgres-extensions.md`.

---

### Task 8: Integrate, push, and perform final release verification

**Files:**
- No new source files.

**Interfaces:**
- Consumes: verified producer branch, published manifests, and verified Worktree DB current branch.
- Produces: both repositories integrated to their intended branches and pushed, with GHCR and tests agreeing on the same digest.

- [ ] **Step 1: Re-run fresh final producer verification**

In the isolated devdb worktree run:

```bash
go build ./...
go vet ./...
go test ./... -count=1
go run ./cmd/worktreedb-build check-manifest
git status --short --branch
```

Expected: PASS and clean feature worktree.

- [ ] **Step 2: Fast-forward devdb main without touching user edits**

In `/Users/jordan/git/devdb`, first confirm the only dirty files remain the three pre-existing `.claude/skills/subagent-driven-development/scripts/*` files. Then run:

```bash
git merge --ff-only codex/neon-promised-extensions
git push origin main
```

Expected: fast-forward succeeds; user files remain modified and unstaged. The pushed head is the `[skip ci]` digest-record commit, so it does not republish identical tags.

- [ ] **Step 3: Re-run fresh final Worktree DB verification**

Run:

```bash
go build ./...
go vet ./...
go test ./... -count=1
golangci-lint run
(cd web && pnpm test && pnpm build)
WORKTREEDB_TEST_IMAGE=worktreedb:producer-extensions go test -tags integration ./integration/... -run 'TestPromisedExtensionsAllMajors|TestPromisedExtensionsPG16Restore' -v -timeout 20m -count=1
git status --short --branch
```

Expected: PASS; only the user's unrelated untracked files remain.

- [ ] **Step 4: Push the current Worktree DB branch**

Run: `git push origin HEAD`

Expected: the current branch pushes successfully without creating another Worktree DB branch.

- [ ] **Step 5: Confirm registry and repository convergence**

Verify:

```text
devdb versions.json engine digest
devdb docker/Dockerfile engine digest
Worktree DB Dockerfile engine digest
GHCR release-9129 manifest-list digest
```

All four must be byte-identical. Inspect the four carrier tags once more and require both architectures.

- [ ] **Step 6: Finish the development branch**

Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Remove the isolated devdb worktree only after its branch is integrated and no uncommitted work remains. Do not remove or alter either pre-existing Worktree DB worktree.
