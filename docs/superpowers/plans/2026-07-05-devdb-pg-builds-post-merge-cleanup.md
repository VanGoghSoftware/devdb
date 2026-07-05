# DevDB dynamic-pg-builds — Post-Merge Cleanup Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the seven deferred Minors + test-adds that the `dynamic-pg-builds` final whole-branch review parked for after merge (deferral chip `task_09f271b8`): FIX-6 (marker-trust hardening), MCP #11, dead-code #12, web #7/#8/#9, and the T2/T14 test-adds — as one cohesive follow-up branch with tests.

**Architecture:** Small, mostly-independent fixes across three surfaces — daemon (`compute/builds/registry.ts`, `mcp/tools.ts`, `state/repos.ts`), web (`settings/PgBuildsCard.tsx`, `pages/DashboardPage.tsx`), and one integration-test rework (`tests/integration/pg-builds.test.ts`). Each task is its own TDD cycle and its own conventional commit; the tasks do not depend on one another and may be reordered, but they DO depend on the pre-merge fix pass (FIX-1..8) already being present.

**Tech Stack:** Node 22, TypeScript (strict; tsc gate forbids `as any`/`as never`), Fastify, better-sqlite3, Zod, Vitest; web is React + Mantine + TanStack Query (jsdom tests); integration is testcontainers + execa.

---

## ⚠️ Preconditions (verify BEFORE starting — this plan was written pre-merge)

This batch was written while `dynamic-pg-builds` (tip `1e69bf4`) was **not yet merged to main**. It is the *post-merge* batch and MUST run on a base that already contains the pre-merge fix pass:

1. **The branch is merged to `main`** (or you are basing this work on `dynamic-pg-builds` tip `1e69bf4`+, which already carries FIX-1..8). Confirm `git log --oneline | grep -E "42d41d7|1e69bf4"` shows both:
   - `42d41d7 fix(builds): final-review hardening — degraded-flag recovery, baked re-probe, shared-dir-safe removal, boot orphan sweep` (FIX-1..5, FIX-7)
   - `1e69bf4 fix(mcp): activate_pg_build refuses Postgres downgrades` (FIX-8)
2. **Confirm each target still exists** (multiple sessions commit in parallel — line numbers below are as of `1e69bf4` and WILL drift; re-grep the symbol before every edit). Per AGENTS.md: verify the reported issue is still present on the actual base before fixing.
3. **Known-env baseline:** the 17 `manager.test.ts` `PortExhaustedError` failures come from a running `docker-devdb-1` holding `127.0.0.1:54300-54339`. Post-merge this is gone (main's hermetic-probe fix `cd058ad`/`806589d` lands with the merge). If you still see them, ask Jordan to `docker compose -f docker/compose.yaml down`. Gate every daemon task by DELTA: **add zero failures outside that set.**

## Global Constraints (apply to EVERY task)

- **TDD with captured RED evidence.** Write the failing test first, run it, record the exact failure reason, then implement. (AGENTS.md: "TDD with captured RED evidence for new work.")
- **No `as any` / `as never`.** Unit tests use typed fakes against the `packages/daemon/src/services/engine-api.ts` interfaces; the daemon test script's tsc gate enforces this.
- **Two gates per task:** an independent reviewer subagent AND a review-broker scan (P1–P2 Critical, P3 Important, P4–P5 Minor). Pass absolute `focusFiles` + `repoRoot`; set `REVIEW_BROKER_DOC=<repo>/docs/codebase-review.md`.
- **Conventional commits.** One commit per task. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (or the model actually used).
- **Oracle rule:** none of these tasks invent engine payloads, so no `// oracle:` citations are required — but do not deviate from existing engine-interaction code.
- **Integration tests** import shared helpers from `tests/integration/helpers/` and are gated separately (`pnpm --filter @devdb/integration test`, ~5 min, needs Docker). Web tests run under jsdom with no port-env issue (`pnpm --filter @devdb/web test`).
- **npm deps ≥ 24h old** (`minimumReleaseAge: 1440`). None of these tasks need a new dependency.

## Commands

```bash
pnpm --filter @devdb/daemon test           # daemon unit (tsc gate + vitest, ~3s). Single file: `test pg-build-registry` (NO `--`, which forwards to the whole suite)
pnpm --filter @devdb/web test              # web unit (jsdom, clean green)
pnpm --filter @devdb/integration test      # container-level (~5 min, needs Docker)
docker build -f docker/Dockerfile -t devdb:dev .   # image (verify gate runs in-build)
```

## File Structure (what each task touches)

| Task | Surface | Files |
|---|---|---|
| 1 · #12 | daemon | `state/repos.ts` (drop `byMajorAndTag`) |
| 2 · T2 | daemon test | `test/pg-builds-repo.test.ts` (add setActiveExclusive rollback + byDigest baked-`''` negative) |
| 3 · FIX-6 | daemon + integration | `compute/builds/registry.ts` (`adoptVolumeBuilds`), `test/pg-build-registry.test.ts`, `tests/integration/pg-builds.test.ts` (test-3 rework) |
| 4 · #11 | daemon | `mcp/tools.ts` (`activate_pg_build`), `test/mcp-tools.test.ts` |
| 5 · #8 | web | `settings/PgBuildsCard.tsx`, `test/pg-builds-card.test.tsx` |
| 6 · #7 | web | `settings/PgBuildsCard.tsx`, `test/pg-builds-card.test.tsx` |
| 7 · #9 | web (+ optional daemon) | `settings/PgBuildsCard.tsx`, `test/pg-builds-card.test.tsx` (optional: `compute/builds/registry.ts` boot sweep) |
| 8 · T14 | web test | `test/dashboard*.test.tsx` (clamp regression) |

Tasks 5, 6, 7 all edit `PgBuildsCard.tsx`; do them in that order to minimize churn, or fold 5+6+7 into one card task with three commits if executing inline.

---

### Task 1: Drop dead `byMajorAndTag` (Minor #12)

**Files:**
- Modify: `packages/daemon/src/state/repos.ts` (remove `PgBuildsRepo.byMajorAndTag`, ~:212-215)

**Context:** `byMajorAndTag(major, tag)` has **zero callers** anywhere in `src` or `test` (verified: `grep -rn "byMajorAndTag"` returns only its own definition). Tags stopped being identity when Task 7 moved to content-addressed (`v{major}/{digest}`) storage — a `(major, tag)` lookup can return any of N same-tag digests. It is production-dead and misleading; remove it.

- [ ] **Step 1: Re-verify it is still dead** (a later session may have wired it)

Run: `grep -rn "byMajorAndTag" packages/ tests/`
Expected: exactly one hit — the definition in `state/repos.ts`. **If any caller exists, STOP** — reassess (the finding has been superseded).

- [ ] **Step 2: Delete the method**

Remove these lines from `PgBuildsRepo` (line numbers as of `1e69bf4`):

```typescript
  byMajorAndTag(major: number, tag: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE major = ? AND release_tag = ?").get(major, tag);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
```

- [ ] **Step 3: Verify the suite still compiles + passes (tsc gate proves no caller broke)**

Run: `pnpm --filter @devdb/daemon test`
Expected: tsc gate passes (no dangling reference), vitest green by delta (only the known-env `manager.test.ts` set may fail; zero new failures).

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/state/repos.ts
git commit -m "refactor(state): drop dead PgBuildsRepo.byMajorAndTag (content-addressing retired tag-identity)"
```

---

### Task 2: Repo test-adds — `setActiveExclusive` rollback + `byDigest` baked-`''` negative (T2)

**Files:**
- Test: `packages/daemon/test/pg-builds-repo.test.ts` (add two tests; test-only, no `src` change)

**Context:** Two P4 coverage gaps from Task 2's review. `setActiveExclusive` is transactional (`repos.ts:245-253` — `UPDATE ... active = 0 WHERE major` then `active = 1 WHERE id`, wrapped in `this.db.transaction`); if it regressed to non-transactional, a throw mid-flip would strand a major with no active row — no existing test catches that. `byDigest` (`repos.ts:205-211`) filters `image_digest != ''` so baked rows (which store `image_digest = ''`) are never returned; removing that guard would fail no existing test.

- [ ] **Step 1: Write the failing tests**

Add to `packages/daemon/test/pg-builds-repo.test.ts` (match the file's existing fixture/`openState`-in-memory setup):

```typescript
it("setActiveExclusive rolls back atomically: a throw on an unknown id leaves the prior active row intact", () => {
  const s = freshState(); // in-memory openState(":memory:") per this file's helper
  s.pgBuilds.insert({ id: "a", major: 17, source: "downloaded", releaseTag: "t", imageDigest: "sha256:aa", path: "/p/a", status: "ready", minor: 5 });
  s.pgBuilds.insert({ id: "b", major: 17, source: "downloaded", releaseTag: "t", imageDigest: "sha256:bb", path: "/p/b", status: "ready", minor: 6 });
  s.pgBuilds.setActiveExclusive("a");
  expect(s.pgBuilds.byId("a")!.active).toBe(true);

  // Unknown id → the tx body throws AFTER clearing active=0 on the major; a correct transaction
  // rolls the clear back, so "a" must remain the sole active row.
  expect(() => s.pgBuilds.setActiveExclusive("missing")).toThrow();
  const active = s.pgBuilds.listByMajor(17).filter((r) => r.active);
  expect(active.map((r) => r.id)).toEqual(["a"]); // exactly one, unchanged — NOT zero (would prove a non-atomic clear)
});

it("byDigest never returns a baked row: image_digest='' is excluded even when queried with ''", () => {
  const s = freshState();
  s.pgBuilds.insert({ id: "baked-v17", major: 17, source: "baked", releaseTag: "baked", imageDigest: "", path: "/pg/v17", status: "ready", minor: 5 });
  expect(s.pgBuilds.byDigest("")).toBeNull();          // the '' guard: a baked row must not be dedup-matched
  s.pgBuilds.insert({ id: "dl", major: 17, source: "downloaded", releaseTag: "t", imageDigest: "sha256:cc", path: "/p/cc", status: "ready", minor: 5 });
  expect(s.pgBuilds.byDigest("sha256:cc")!.id).toBe("dl"); // positive control: a real digest still resolves
});
```

*(Use the file's own state factory — read the top of `pg-builds-repo.test.ts` for the exact helper name; `freshState()` above is a placeholder for it.)*

- [ ] **Step 2: Run to verify they pass GREEN immediately (these pin existing-correct behavior)**

Run: `pnpm --filter @devdb/daemon test pg-builds-repo`
Expected: both PASS. To prove they are load-bearing, temporarily (a) remove the `this.db.transaction` wrapper in `setActiveExclusive` → rollback test FAILS; (b) drop `AND image_digest != ''` in `byDigest` → baked-`''` test FAILS. Revert both. Record this mutation evidence in the commit body / task report (these are regression guards, not RED-first features).

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/test/pg-builds-repo.test.ts
git commit -m "test(state): pin setActiveExclusive tx rollback + byDigest baked-'' exclusion (T2)"
```

---

### Task 3: FIX-6 — `adoptVolumeBuilds` validates the marker + re-detects the version (Important, durability)

**Files:**
- Modify: `packages/daemon/src/compute/builds/registry.ts` (`adoptVolumeBuilds`, ~:94-116; `BuildMarker` type, :7)
- Test (unit): `packages/daemon/test/pg-build-registry.test.ts` (negative + positive adoption)
- Test (integration): `tests/integration/pg-builds.test.ts` (rework test 3 — see the dedicated design section below)

**Interfaces:**
- Consumes: `this.deps.detectVersion(pgbin) → Promise<{major, minor}>` (already a constructor dep, used by `seedBaked`); `shortDigest(digest)` (registry.ts:13).
- Produces: no signature change — `adoptVolumeBuilds(): Promise<void>` unchanged; only its trust model changes.

**Context (the defect):** `adoptVolumeBuilds` does `JSON.parse(await readFile(build.json)) as BuildMarker` (registry.ts:105) — a raw cast — then trusts `marker.major/minor/digest` after only an `access(bin/postgres)` check (:108). It does NOT: validate the marker's shape (a malformed-but-parseable marker inserts `undefined` major/minor); require `marker.major` to match the `vN` dir; require `shortDigest(marker.digest)` to match the entry dir name; or re-detect the actual version (unlike `seedBaked`, which after FIX-2 always `detectVersion`s — see registry.ts:65,74). A corrupt/inconsistent marker ⇒ an older binary can appear as e.g. `17.99`, win active resolution, and DODGE the never-silent-downgrade flag (`resolveActives` compares the forged minor). This is the one adoption path that trusts a stored version instead of the binary. FIX-6 makes it symmetric with FIX-2's `seedBaked`.

- [ ] **Step 1: Write the failing UNIT tests** (primary FIX-6 coverage — fast + hermetic)

Add to `packages/daemon/test/pg-build-registry.test.ts`. This file already fakes `detectVersion` and lays down `pgBuildsDir/vN/<entry>/build.json` + `bin/postgres` fixtures — reuse that harness. Three cases:

```typescript
it("adoptVolumeBuilds adopts the DETECTED version, not the marker's claimed one (coherent marker)", async () => {
  // marker says 17.5; the binary detects 17.6 — a coherent (dir/digest match) marker whose minor
  // drifted. Post-FIX-6 the ADOPTED row carries the detected 17.6, never the marker's 5.
  const digest = "sha256:" + "a".repeat(64);
  writeVolumeBuild({ vdir: "v17", entry: shortDigest(digest), marker: { digest, tag: "9999", major: 17, minor: 5, extractedAt: "t" } });
  const reg = makeRegistry({ detectVersion: async () => ({ major: 17, minor: 6 }) });
  await reg.adoptVolumeBuilds();
  const row = reg.list().find((r) => r.source === "downloaded");
  expect(row?.minor).toBe(6);            // detected, not marker's 5
  expect(row?.status).toBe("ready");
});

it("adoptVolumeBuilds REJECTS a marker whose dir name != shortDigest(marker.digest) (forged high-water)", async () => {
  const digest = "sha256:" + "a".repeat(64);
  // entry dir "fake99-<short>" does not equal shortDigest(digest); marker forged to minor 99.
  writeVolumeBuild({ vdir: "v17", entry: "fake99-" + shortDigest(digest), marker: { digest, tag: "9999", major: 17, minor: 99, extractedAt: "t" } });
  const reg = makeRegistry({ detectVersion: async () => ({ major: 17, minor: 5 }) });
  await reg.adoptVolumeBuilds();
  expect(reg.list().some((r) => r.status === "ready" && r.minor === 99)).toBe(false); // never surfaces the forged 17.99
});

it("adoptVolumeBuilds REJECTS a marker whose major disagrees with the vN dir / detected binary", async () => {
  const digest = "sha256:" + "b".repeat(64);
  writeVolumeBuild({ vdir: "v17", entry: shortDigest(digest), marker: { digest, tag: "9999", major: 16, minor: 3, extractedAt: "t" } }); // major 16 under v17
  const reg = makeRegistry({ detectVersion: async () => ({ major: 17, minor: 5 }) });
  await reg.adoptVolumeBuilds();
  expect(reg.list().some((r) => r.status === "ready")).toBe(false); // inconsistent major → not adopted
});

it("adoptVolumeBuilds REJECTS a malformed (shape-invalid) marker instead of inserting undefined fields", async () => {
  writeVolumeBuildRaw({ vdir: "v17", entry: "deadbeefdeadbeef", json: '{"tag":"9999"}' }); // no digest/major/minor
  const reg = makeRegistry({ detectVersion: async () => ({ major: 17, minor: 5 }) });
  await reg.adoptVolumeBuilds();
  expect(reg.list().length).toBe(0);
});
```

*(`writeVolumeBuild` / `writeVolumeBuildRaw` / `makeRegistry` are placeholders for this file's existing fixture helpers — read the file and reuse them; `writeVolumeBuildRaw` writes an arbitrary `build.json` string.)*

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon test pg-build-registry`
Expected: the three REJECT tests FAIL (pre-FIX-6 the forged/inconsistent/malformed markers are adopted as ready rows) and the coherent test FAILS on `minor` (adopts marker's 5, not detected 6).

- [ ] **Step 3: Implement — validate shape, check dir/digest/major consistency, re-detect + adopt detected version**

Add a schema near `BuildMarker` (registry.ts:7). Prefer an explicit runtime check (zero new import) or `zod` if already imported in this module — check the imports; `state`/`shared` use zod, so `import { z } from "zod"` is in-tree. Explicit-check version (no new import):

```typescript
interface BuildMarker { digest: string; tag: string; major: number; minor: number; extractedAt: string }

function parseMarker(raw: string): BuildMarker {
  const m = JSON.parse(raw) as Record<string, unknown>;
  if (typeof m.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(m.digest)) throw new Error("marker.digest not a sha256 digest");
  if (typeof m.tag !== "string") throw new Error("marker.tag not a string");
  if (typeof m.major !== "number" || !Number.isInteger(m.major)) throw new Error("marker.major not an integer");
  if (typeof m.minor !== "number" || !Number.isInteger(m.minor)) throw new Error("marker.minor not an integer");
  if (typeof m.extractedAt !== "string") throw new Error("marker.extractedAt not a string");
  return m as BuildMarker;
}
```

Replace the `adoptVolumeBuilds` per-entry `try` body (registry.ts:104-115) with:

```typescript
try {
  const vMajor = Number(/^v(\d+)$/.exec(vdir)![1]); // vdir already matched /^v\d+$/ above
  const marker = parseMarker(await readFile(join(path, "build.json"), "utf8"));
  // Identity + consistency: dir name IS the content-address; the marker's major IS the vN dir.
  if (shortDigest(marker.digest) !== entry) throw new Error(`marker digest ${shortDigest(marker.digest)} != dir ${entry}`);
  if (marker.major !== vMajor) throw new Error(`marker major ${marker.major} != dir v${vMajor}`);
  const id = `dl-${marker.major}-${shortDigest(marker.digest)}`;
  if (this.deps.state.pgBuilds.byId(id)) continue;
  // Re-detect from the BINARY (subsumes the old access() probe) and adopt the DETECTED version —
  // symmetric with seedBaked (FIX-2). A binary that disagrees with its own marker is not trusted.
  const detected = await this.deps.detectVersion(join(path, "bin", "postgres"));
  if (detected.major !== marker.major) throw new Error(`binary major ${detected.major} != marker major ${marker.major}`);
  this.deps.state.pgBuilds.insert({
    id, major: detected.major, minor: detected.minor, source: "downloaded",
    releaseTag: marker.tag, imageDigest: marker.digest, path, status: "ready",
  });
} catch (e) {
  this.deps.logger.error(`skipping unadoptable volume build at ${path}`, e);
}
```

**Design decision (disclosed):** consistency/shape/version-disagreement failures **skip with a log** (extending the existing `catch`'s "unadoptable" path), rather than inserting a `failed` row. Rationale: a marker we can't trust for identity can't be trusted to key a row either; the existing adopt path already skips-and-logs unparseable markers, so this is consistent. (Alternative — insert a `failed` row for a *dir/digest-coherent but version-disagreeing* binary so it surfaces in the UI — is defensible; if the reviewer prefers surfacing, do it only for the post-consistency `detected.major !== marker.major` branch. Default: skip+log.)

- [ ] **Step 4: Run to verify GREEN (unit)**

Run: `pnpm --filter @devdb/daemon test pg-build-registry`
Expected: all four new tests PASS; the pre-existing `pg-build-registry` tests stay green.

- [ ] **Step 5: Rework the integration test (see "FIX-6 integration-test rework" section below), then verify**

Run: `pnpm --filter @devdb/integration test pg-builds` *(needs Docker; ~4 min for this file — the 3 tests total ~500s)*
Expected: all 3 tests pass with the reworked test 3.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/compute/builds/registry.ts packages/daemon/test/pg-build-registry.test.ts tests/integration/pg-builds.test.ts
git commit -m "fix(builds): adoptVolumeBuilds validates marker shape/identity + adopts detected version (FIX-6)"
```

---

### Task 4: MCP `activate_pg_build` accepts a disambiguator for same-minor rebuilds (Minor #11)

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts` (`ActivatePgBuildShape` + handler, ~:565-609)
- Test: `packages/daemon/test/mcp-tools.test.ts`

**Context:** After content-addressing (Task 7), a same-`major.minor` rebuild under a new digest yields TWO ready rows with identical `versionString`. The handler resolves the target with `candidates.find((r) => r.status === "ready" && versionString(r) === version)` (tools.ts:571) — `find` returns the FIRST (oldest by `list()`'s `ORDER BY major, created_at`), silently picking a stale build. This is the same class `ec0027a` addressed for `list_pg_builds`. FIX-8 (refuse-downgrades) already landed on this handler; layer the disambiguator on top — the downgrade check runs on the chosen target unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `packages/daemon/test/mcp-tools.test.ts` (reuse its `registry`/`state` fakes):

```typescript
it("activate_pg_build is AMBIGUOUS when two ready builds share a version, and refuses without a disambiguator", async () => {
  // two ready 17.5 rows, different digests (same-minor rebuild)
  seedReady({ id: "dl-17-aaaa", major: 17, minor: 5, digest: "sha256:" + "a".repeat(64) });
  seedReady({ id: "dl-17-bbbb", major: 17, minor: 5, digest: "sha256:" + "b".repeat(64) });
  const res = await callTool("activate_pg_build", { major: 17, version: "17.5" });
  expect(res.isError).toBe(true);
  expect(text(res)).toMatch(/ambiguous/i);
  expect(text(res)).toContain("dl-17-aaaa");
  expect(text(res)).toContain("dl-17-bbbb");
  expect(activateSpy).not.toHaveBeenCalled();
});

it("activate_pg_build with an explicit id activates exactly that row", async () => {
  seedReady({ id: "dl-17-aaaa", major: 17, minor: 5, digest: "sha256:" + "a".repeat(64) });
  seedReady({ id: "dl-17-bbbb", major: 17, minor: 5, digest: "sha256:" + "b".repeat(64) });
  const res = await callTool("activate_pg_build", { major: 17, version: "17.5", id: "dl-17-bbbb" });
  expect(res.isError).toBeFalsy();
  expect(activateSpy).toHaveBeenCalledWith("dl-17-bbbb"); // provisioner.activate(id), FIX-8 no-consent path
});

it("activate_pg_build with a single ready build ignores the (optional) id and works unchanged", async () => {
  seedReady({ id: "dl-17-aaaa", major: 17, minor: 6, digest: "sha256:" + "a".repeat(64) });
  const res = await callTool("activate_pg_build", { major: 17, version: "17.6" });
  expect(res.isError).toBeFalsy();
  expect(activateSpy).toHaveBeenCalledWith("dl-17-aaaa");
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon test mcp-tools`
Expected: the ambiguity test FAILS (today `find` silently picks `dl-17-aaaa`, no error); the explicit-id test FAILS on schema (`id` not accepted → the arg is ignored, activates the oldest).

- [ ] **Step 3: Implement**

Extend the shape and target resolution (tools.ts:565-578). Keep FIX-8's downgrade block (:580-599) and the `provisioner.activate(target.id)` call (:605) unchanged.

```typescript
const ActivatePgBuildShape = { major: PgVersionSchema, version: z.string().regex(/^\d+\.\d+$/), id: z.string().optional() };
```

```typescript
}, guard("activate_pg_build", deps, async ({ major, version, id }: z.infer<z.ZodObject<typeof ActivatePgBuildShape>>) => {
  const candidates = deps.registry.list().filter((r) => r.major === major);
  const ready = candidates.filter((r) => r.status === "ready" && versionString(r) === version);
  let target: PgBuildRow | undefined;
  if (id) {
    target = ready.find((r) => r.id === id);
    if (!target) {
      return errorResult(
        `no ready build ${version} for PG ${major} with id ${id}` +
        (ready.length > 0 ? ` — ready ids at ${version}: ${ready.map((r) => r.id).join(", ")}` : ` — none ready at ${version}`),
      );
    }
  } else if (ready.length > 1) {
    return errorResult(
      `ambiguous: ${ready.length} ready builds at ${version} for PG ${major} — re-call with id to pick one: ` +
      ready.map((r) => `${r.id} (digest ${r.imageDigest.replace(/^sha256:/, "").slice(0, 12)})`).join(", "),
    );
  } else {
    target = ready[0];
  }
  if (!target) {
    const available = candidates.filter((r) => r.status === "ready").map(versionString);
    return errorResult(
      `no ready build ${version} for PG ${major}` +
      (available.length > 0 ? ` — available: ${available.join(", ")}` : ` — none ready; pull_pg_build first`),
    );
  }
  // ... FIX-8 downgrade refusal (unchanged) ... then: const row = await deps.provisioner.activate(target.id);
```

Update the tool `description` to mention the optional `id` for same-version disambiguation.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @devdb/daemon test mcp-tools`
Expected: all three new tests PASS; existing `activate_pg_build` tests (incl. FIX-8's refuse-downgrade) stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/test/mcp-tools.test.ts
git commit -m "fix(mcp): activate_pg_build accepts optional id to disambiguate same-minor rebuilds (#11)"
```

---

### Task 5: Web card — union in-flight/failed majors + persist updateAvailable from the server (Minor #8)

**Files:**
- Modify: `packages/web/src/settings/PgBuildsCard.tsx` (`PgBuildsCard`, ~:154-201)
- Test: `packages/web/test/pg-builds-card.test.tsx`

**Context (two defects):**
1. `majors` is derived from `Object.keys(status.pgBuilds)` (ready-only majors) at PgBuildsCard.tsx:166. An in-flight/failed **new** major has a row in `usePgBuilds()` but no `status.pgBuilds` entry yet → its section is invisible, even though the pull is running. Same class as `ec0027a` (fixed for the MCP `list_pg_builds`).
2. `updateAvailable={checked?.isNew ? checked.tag : null}` (:193) renders ONLY the component-local check result and ignores the server's persisted `status.pgBuilds[m].updateAvailable` — so the badge vanishes on reload even though the daemon remembers it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/test/pg-builds-card.test.tsx` (reuse its `useStatus`/`usePgBuilds` mocking; render with TanStack Query provider per the file's harness):

```typescript
it("renders a section for an in-flight NEW major present only in usePgBuilds (not yet in status.pgBuilds)", async () => {
  mockStatus({ pgBuilds: { "17": ready17 } });                // status knows only 17
  mockPgBuilds([{ ...ready17row }, { major: 18, status: "downloading", version: null, source: "downloaded", id: "dl-18-x" }]);
  renderCard();
  expect(await screen.findByText("PG 18")).toBeInTheDocument(); // section visible despite no status.pgBuilds["18"]
});

it("shows the update-available badge from status.pgBuilds[m].updateAvailable after reload (no local check run)", async () => {
  mockStatus({ pgBuilds: { "17": { ...ready17, updateAvailable: "9999" } } });
  mockPgBuilds([ready17row]);
  renderCard();                                                 // no Check-for-updates click
  expect(await screen.findByText(/update available/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: "PG 18" test FAILS (major 18 not rendered — majors came from status only); badge test FAILS (badge absent without a local check).

- [ ] **Step 3: Implement**

In `PgBuildsCard` (PgBuildsCard.tsx:165-197):

```typescript
if (!status) return null;
const statusMajors = Object.keys(status.pgBuilds).map(Number);
const buildMajors = (builds ?? []).map((b) => b.major);
const majors = [...new Set([...statusMajors, ...buildMajors])].sort((x, y) => x - y);
```

```typescript
{majors.map((major) => {
  const majorStatus = status.pgBuilds[String(major)]; // undefined for an in-flight new major
  const majorBuilds = (builds ?? []).filter((b) => b.major === major);
  const checked = checkResult[String(major)];
  return (
    <MajorSection
      key={major}
      major={major}
      activeVersion={majorStatus?.activeVersion ?? null}
      source={majorStatus?.source ?? null}
      degradedDowngrade={majorStatus?.degradedDowngrade ?? false}
      updateAvailable={checked?.isNew ? checked.tag : (majorStatus?.updateAvailable ?? null)}
      builds={majorBuilds}
    />
  );
})}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: both new tests PASS; existing card tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings/PgBuildsCard.tsx packages/web/test/pg-builds-card.test.tsx
git commit -m "fix(web): PgBuildsCard unions in-flight majors + falls back to server updateAvailable (#8)"
```

---

### Task 6: Web card — consent-retry an Activate the daemon 409s as a downgrade (Minor #7)

**Files:**
- Modify: `packages/web/src/settings/PgBuildsCard.tsx` (`BuildRow`, ~:41-77)
- Test: `packages/web/test/pg-builds-card.test.tsx`

**Context:** The card computes `isDowngrade` against the **active** minor (`a.activeMinor`, PgBuildsCard.tsx:41), but the daemon's guard (registry.ts `activate`) fires against the **last-run high-water**. In a degraded state (active < lastRun), a build with `minor ≥ activeMinor` is NOT a local downgrade, so the card activates WITHOUT `consented` → the daemon 409s ("would downgrade below the last-run …") and the UI dead-ends with a toast and no consent path. Fix: on a 409-downgrade error, `window.confirm` and retry with `consented: true`. `ApiError` carries `status` and the daemon's message (`class ApiError extends Error { constructor(public status: number, message: string) }`, web `api/client.ts:3-4`); the downgrade 409's message contains "downgrade".

- [ ] **Step 1: Write the failing test**

```typescript
it("consent-retries an Activate the daemon 409s as a downgrade (degraded state the local heuristic misses)", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  // First mutate 409s with a downgrade message; assert the retry carries consented:true.
  const activateMock = mockActivate();
  activateMock.mockRejectedValueOnce(new ApiError(409, "activating 17.4 would downgrade below the last-run 17.6 — pass consented:true"));
  renderCard(/* active 17.4, a ready 17.5 row that is NOT a local downgrade */);
  await userEvent.click(screen.getByRole("button", { name: /activate/i }));
  await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  await waitFor(() => expect(activateMock).toHaveBeenLastCalledWith({ id: expect.any(String), consented: true }));
});

it("does NOT retry when the user declines the downgrade confirm", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const activateMock = mockActivate();
  activateMock.mockRejectedValueOnce(new ApiError(409, "would downgrade below the last-run 17.6"));
  renderCard();
  await userEvent.click(screen.getByRole("button", { name: /activate/i }));
  await waitFor(() => expect(activateMock).toHaveBeenCalledTimes(1)); // no consented retry
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: FAIL — today a 409 just surfaces via the global `onError` toast; no confirm, no `consented:true` retry.

- [ ] **Step 3: Implement**

Replace `BuildRow`'s Activate `onClick` (PgBuildsCard.tsx:65-74) with a retry-on-409-downgrade flow. Keep the fast local-heuristic confirm to avoid a needless round-trip when we already know it's a downgrade; add the server-authoritative catch for the degraded case the heuristic misses:

```typescript
import { ApiError } from "../api/client.js";

const downgradeMsg = `Activating ${row.version} would downgrade Postgres ${row.major} below its last-used minor. The neon extension's catalog upgrades forward-only. Continue?`;
const isDowngradeConflict = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && /downgrade/i.test(e.message);

const doActivate = (consented?: boolean): void =>
  activate.mutate(
    { id: row.id, consented },
    { onError: (e) => { if (isDowngradeConflict(e) && window.confirm(downgradeMsg)) doActivate(true); } },
  );

// onClick:
() => {
  if (isDowngrade) { if (window.confirm(downgradeMsg)) doActivate(true); } // known-local downgrade: confirm up front
  else doActivate(undefined);                                             // else optimistic; the onError catches a server-side (high-water) downgrade
}
```

Note: the per-`mutate` `onError` runs in addition to the hook's default `onError` toast; the retry path is additive. Guard against an infinite loop — the retry passes `consented:true`, which the daemon accepts, so `onError` won't re-fire the downgrade branch.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: both tests PASS; existing Activate tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings/PgBuildsCard.tsx packages/web/test/pg-builds-card.test.tsx
git commit -m "fix(web): PgBuildsCard consent-retries a server-side downgrade 409 (#7)"
```

---

### Task 7: Web card — enable Delete for failed rows; optional boot-sweep of stale failed rows (Minor #9)

**Files:**
- Modify: `packages/web/src/settings/PgBuildsCard.tsx` (`BuildRow` failed branch, ~:25-38)
- Test: `packages/web/test/pg-builds-card.test.tsx`
- Optional (daemon): `packages/daemon/src/compute/builds/registry.ts` + `packages/daemon/src/index.ts` (+ `test/pg-build-registry.test.ts`) for a boot sweep

**Context:** Failed pg-build rows accumulate unbounded — the failed branch offers only "Retry pull", and Retry on a dedup no-op mints ANOTHER failed row. There was no cleanup path. **This task is unblocked by the pre-merge pass:** FIX-3 made `remove()` shared-dir-safe (rm only when `row.path !== ""` AND no sibling row claims the path) and FIX-4 made empty-path rows never "in use" — so deleting a failed row can no longer destroy an active build's shared dir. Enable UI Delete for failed rows.

- [ ] **Step 1: Write the failing test**

```typescript
it("a failed row offers Delete (safe post-FIX-3/4) and calls deletePgBuild with the row id", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const delMock = mockDelete();
  mockPgBuilds([{ major: 17, id: "dl-17-bad", status: "failed", error: "gate failed", version: null, source: "downloaded" }]);
  renderCard();
  await userEvent.click(screen.getByRole("button", { name: /delete/i }));
  expect(delMock).toHaveBeenCalledWith("dl-17-bad");
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: FAIL — the failed branch renders only "Retry pull"; there is no Delete button.

- [ ] **Step 3: Implement**

In `BuildRow`'s `failed` branch (PgBuildsCard.tsx:25-38), add a Delete button beside Retry (reuse the `useDeletePgBuild` hook already imported as `del`):

```typescript
if (row.status === "failed") {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">{row.error ?? "pull failed"}</Text>
      <Group gap="xs">
        <Button size="compact-xs" loading={pull.isPending}
          onClick={() => pull.mutate({ major: row.major, tag: row.releaseTag })}>Retry pull</Button>
        <Button size="compact-xs" color="red" variant="light" loading={del.isPending}
          onClick={() => { if (window.confirm(`Delete this failed build record for PG ${row.major}? This cannot be undone.`)) del.mutate(row.id); }}>
          Delete
        </Button>
      </Group>
    </Group>
  );
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @devdb/web test pg-builds-card`
Expected: PASS; existing failed-row (Retry) tests stay green.

- [ ] **Step 5 (OPTIONAL — decide with the reviewer): boot-sweep stale failed rows**

Only if the batch wants server-side GC too (the UI delete already bounds accumulation in practice). Add to `BuildRegistry`:

```typescript
// Boot GC: drop downloaded 'failed' rows older than maxAgeMs. Uses the same shared-path-safe
// discipline as remove() — never rm a dir a sibling row still claims; empty-path rows just drop.
sweepFailed(maxAgeMs: number, nowMs: number): number { /* iterate list(); for failed downloaded rows with createdAt older than cutoff, delete row (rm dir only if path !== '' and no sibling claims it) */ }
```

Wire it in `index.ts` boot order after `failInterrupted()`; unit-test with an injected clock (do NOT call `Date.now()` in the method — pass `nowMs`). Commit separately (`feat(builds): boot GC for stale failed pg-build rows`). **Default: skip** unless the reviewer asks — keep the batch bounded; the UI delete is the primary fix, and the report's adjacent finalDir-orphan wrinkle (below) is explicitly out of scope.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings/PgBuildsCard.tsx packages/web/test/pg-builds-card.test.tsx
git commit -m "fix(web): PgBuildsCard offers Delete on failed rows (safe post-FIX-3/4) (#9)"
```

---

### Task 8: T14 — clamp-when-DEFAULT_PG_VERSION-absent regression test (web)

**Files:**
- Test: `packages/web/test/` — the DashboardPage/create-modal test file (read `pages/DashboardPage.tsx` — the create modal is the `NewProjectModal`/inline component around :38-59; find its existing test)

**Context:** `DashboardPage`'s create picker clamps: `effectivePg = majors.includes(Number(pg)) ? pg : String(majors.at(-1) ?? DEFAULT_PG_VERSION)` (DashboardPage.tsx:45), where `majors` comes from `status.pgBuilds`. When the loaded majors EXCLUDE `DEFAULT_PG_VERSION`, both the Select value and the submitted `pgVersion` must clamp to an in-list major. Task 14's review verified this is correct but left it without a regression test (P5).

- [ ] **Step 1: Write the (passing-guard) test**

```typescript
import { SUPPORTED_PG_VERSIONS, DEFAULT_PG_VERSION } from "@devdb/shared";

it("create picker clamps to an installed major when DEFAULT_PG_VERSION isn't among the loaded builds", async () => {
  const majors = SUPPORTED_PG_VERSIONS.filter((v) => v !== DEFAULT_PG_VERSION); // exclude the default
  const highest = Math.max(...majors);
  mockStatus({ pgBuilds: Object.fromEntries(majors.map((v) => [String(v), majorStatusReady(v)])) });
  const createMock = mockCreateProject();
  renderDashboardCreateModal();
  // Select shows the clamped value, not the absent default:
  expect(screen.getByRole("textbox", { name: /postgres/i /* or the Select's accessible name */ })).toHaveValue(`PG ${highest}`);
  await userEvent.type(screen.getByLabelText(/name/i), "proj");
  await userEvent.click(screen.getByRole("button", { name: /create/i }));
  expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ pgVersion: highest })); // clamped, not DEFAULT_PG_VERSION
});
```

*(Adapt selectors to the actual modal markup — read the existing dashboard test for the render helper and Mantine Select query pattern.)*

- [ ] **Step 2: Run — verify it PASSES (pins existing-correct behavior), then prove it's load-bearing**

Run: `pnpm --filter @devdb/web test dashboard`
Expected: PASS. To confirm it guards the clamp, temporarily change `effectivePg` to just `pg` → the test FAILS (submits the absent default). Revert.

- [ ] **Step 3: Commit**

```bash
git add packages/web/test/
git commit -m "test(web): pin create-picker clamp when DEFAULT_PG_VERSION absent from loaded majors (T14)"
```

---

## FIX-6 integration-test rework (design for Task 3, Step 5)

**File:** `tests/integration/pg-builds.test.ts` — test 3 (`"volume build survives re-up; fake-17.99 marker adopts + records high-water; deleting it flags the downgrade"`, currently :212-262).

**Why it breaks:** test 3 fakes a `17.99` high-water by (a) `mv <dir> fake99-<short>` to un-claim the path so `adoptVolumeBuilds` re-reads the marker, then (b) `sed`ing `build.json` to `"minor":99`, then asserting the daemon adopts the forged `17.99` and it wins active resolution (:236-242). FIX-6 makes exactly that forged adoption fail: the entry dir `fake99-<short>` ≠ `shortDigest(digest)`, the marker's minor `99` ≠ the binary's detected `17.5`, and adoption re-detects + validates. The forged `17.99` will no longer surface — so test 3's high-water mechanism must move to a legit path (task prompt's prescription: `docker exec … sqlite3` to set `pg_majors.last_run_minor`).

**Established container facts (from `1e69bf4`):**
- Data dir is `/data`; state DB is `/data/state.db` (`openState(join(cfg.dataDir, "state.db"))`, index.ts:60); WAL mode.
- `sqlite3` CLI is **NOT** in the image (Dockerfile apt list has no `sqlite3`). But `better-sqlite3` IS (the daemon depends on it), resolvable from `/app/packages/daemon` (WORKDIR `/app`, daemon package there).
- `pg_majors` schema: `(major INTEGER, last_run_minor INTEGER)`; the raise-only upsert is `INSERT … ON CONFLICT(major) DO UPDATE SET last_run_minor = MAX(…)` — but we set an ARTIFICIAL high, so use a plain overwrite upsert.
- The test already `docker exec`s via `execa("docker", ["exec", dev.container.getId(), …])` (:236, :255).

**Reworked test 3 — three coherent steps:**

**(1) Re-up survival — UNCHANGED** (this IS the coherent-marker-adopts positive control): restart, assert the real downloaded `17.5` row is still `ready` and the major serves `17.5`, `degradedDowngrade === false` (existing :215-225).

**(2) Forged marker is REJECTED, not adopted** (repurpose the existing `mv`+`sed` machinery to prove FIX-6's rejection). Keep the `mv <dir> fake99-<short>` + `sed "minor":<baked>→99` exec (:233-237), then restart, then assert rejection instead of adoption:

```typescript
// FIX-6: adoptVolumeBuilds now validates the marker (dir==shortDigest, major==vN) and adopts the
// DETECTED binary version — a forged marker (wrong dir name + minor 99 vs the real 17.5 binary) is
// REJECTED, not surfaced. The moved-away original row is failed by the missing-binary sweep, so the
// major falls back to baked 17.5.
const short = seededDigest.replace(/^sha256:/, "").slice(0, 16);
const dir = `/data/pg_builds/v17/${short}`;
const dir99 = `/data/pg_builds/v17/fake99-${short}`;
await execa("docker", ["exec", dev.container.getId(), "sh", "-c",
  `mv ${dir} ${dir99} && sed -i 's/"minor":${bakedMinor}/"minor":99/' ${dir99}/build.json`]);
await dev.restart({ timeout: 60_000 });
await waitHealthy();
expect((await listBuilds()).some((r) => r.status === "ready" && r.version === "17.99")).toBe(false); // forged 17.99 NOT adopted
let m = await major17();
expect(m.activeVersion).toBe(bakedVersion);   // fell back to baked 17.5
expect(m.source).toBe("baked");
expect(m.degradedDowngrade).toBe(false);       // 5 is not below the recorded high-water (still 5 from test 1)
```

**(3) Downgrade guard via a LEGIT high-water injection** (replaces the forged-run high-water). Set `pg_majors.last_run_minor = 99` directly in the daemon's state DB via `better-sqlite3` (no image change, no forged version), then restart so boot `resolveActives` compares baked `17.5 < 99`:

```typescript
// Inject an artificial high-water the legit way (the forged-build path is gone). better-sqlite3 is
// in the image; resolve it from the daemon package dir. busy_timeout covers the daemon's WAL writer.
await execa("docker", ["exec", "-w", "/app/packages/daemon", dev.container.getId(), "node", "-e",
  `const D=require('better-sqlite3');const db=new D('/data/state.db');db.pragma('busy_timeout=5000');` +
  `db.prepare("INSERT INTO pg_majors (major,last_run_minor) VALUES (17,99) ON CONFLICT(major) DO UPDATE SET last_run_minor=99").run();db.close();`]);
// Remove the moved-away forged dir so only baked 17.5 remains resolvable, then re-derive at boot.
await execa("docker", ["exec", dev.container.getId(), "rm", "-rf", dir99]);
await dev.restart({ timeout: 60_000 });
await waitHealthy();
m = await major17();
expect(m.degradedDowngrade).toBe(true);        // baked 17.5 < injected high-water 99 → never-silent-downgrade flag (spec decision 10)
expect(m.activeVersion).toBe(bakedVersion);
expect(m.source).toBe("baked");
```

**Rename the test** to reflect the new behavior, e.g. `"volume build survives re-up; a forged marker is rejected; an injected high-water flags the downgrade on fallback"`.

**Notes / gotchas for the executor:**
- The `docker exec … node -e` write happens while the daemon runs (WAL + `busy_timeout` handle the brief lock; the daemon is quiescent at this point — test 2 drove both stub pulls to terminal). The subsequent `restart()` guarantees a fresh boot read regardless.
- If `require('better-sqlite3')` fails to resolve in-container (pnpm layout), fall back to `require.resolve('better-sqlite3',{paths:['/app/packages/daemon']})`. Do NOT add `sqlite3` to the product Dockerfile just for a test.
- The unit tests in Task 3 are the PRIMARY FIX-6 coverage; this integration rework keeps the order-dependent test-3 chain green end-to-end and proves the rejection across a real boot. Per "no silent caps": if any assertion here is dropped rather than reworked, `log`/comment it loudly.

---

## Out of scope (do NOT fold in without a separate decision)

- **FIX-5 orphan-finalDir wrinkle** (from `final-fix-report.md` §"Couldn't do"): a FIX-5-failed `validating` orphan keeps its real `finalDir`; a same-digest re-pull BEFORE its DELETE fails `ENOTEMPTY` at `rename(tmpDir, finalDir)` (recoverable: DELETE orphan → re-pull succeeds; `sweepTmp` reclaims the tmp next boot). A nicer story (boot-rm of an interrupted row's dir, or retry pre-clearing a same-digest finalDir) is a candidate for a FUTURE hygiene batch — not this one.
- **Merge-time spec amendments** (owned by whoever merges the branch, not this batch): `v{major}/{digest}` layout; baked-Delete-409; the FIX-8 MCP-refuses-downgrade ruling; README "garbage-collects the rest" = boot GC + manual delete.

## Self-Review (completed against the task brief + `final-review-agenda.md` §B)

- **Coverage:** FIX-6 → Task 3; #11 → Task 4; #12 → Task 1; #7 → Task 6; #8 → Task 5; #9 → Task 7; T2 → Task 2; T14 → Task 8. All eight items mapped.
- **Dependency check:** #9 (Task 7) depends on FIX-3/FIX-4 — both landed in `42d41d7` (empty-path-safe `remove()` + never-in-use). #11 (Task 4) layers on FIX-8's handler (`1e69bf4`) — the disambiguator resolves `target` before FIX-8's downgrade block, which is unchanged. FIX-6 (Task 3) mirrors FIX-2's `seedBaked` (`42d41d7`). Preconditions section gates all three.
- **Type consistency:** `detectVersion(pgbin) → {major, minor}`, `shortDigest(digest)`, `versionString(row)`, `ApiError{status,message}`, `effectivePg` clamp — all names taken verbatim from the `1e69bf4` source.
- **Placeholder honesty:** test-helper names (`freshState`, `makeRegistry`, `writeVolumeBuild`, `mockActivate`, etc.) are explicitly flagged as placeholders for each test file's existing harness — read the file and substitute. All production code is concrete.
