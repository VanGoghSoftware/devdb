# De-neond References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every reference to the third-party `matisiekpl/neond` project from DevDB's code and docs, re-pointing engine-interaction citations to official `neondatabase/neon` and reframing product/impl choices as DevDB's own — with **zero runtime behavior change**.

**Architecture:** A category-batched comment/doc sweep. The 48 `// oracle:` citations cluster into ~5 neon subsystems; each task re-points one cluster to its pinned neon authority (naming the exact neon file/endpoint), reframes the genuinely-neond product choices as DevDB-own, and proves no behavior changed by keeping the daemon suite green. It is comments + Markdown only — no `.ts`/`.rs` logic is touched.

**Tech Stack:** TypeScript daemon (comments only); Markdown docs; `~/git/neon @ 8f60b04` as the citation reference (already cloned); `grep`/`ripgrep` for verification; `pnpm --filter @devdb/daemon test` as the no-behavior-change gate.

## Global Constraints

- **Reference authority:** `neondatabase/neon @ 8f60b04` (cloned to `~/git/neon`, shallow). Cite neon at **file + symbol/endpoint** granularity, never exact line numbers (neon moves; this is provenance, not verification).
- **Zero behavior change:** edits touch only comments and Markdown. No function/type/logic edits. `pnpm --filter @devdb/daemon test` must stay green (623 tests) after every task.
- **Do NOT re-evaluate behavior:** if a citation's neon authority appears to *differ* from what DevDB does, record it as a one-line note in the plan's running "Divergence notes" (bottom of this file) and move on — **never change behavior to match** (out of scope per spec).
- **Citation format:** `// oracle: neon <path-or-endpoint>[ — short note]`. Examples: `// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline (routes.rs)`, `// oracle: neon control_plane/src/endpoint.rs → EndpointConf`.
- **Product/impl choices** (DevDB's own SQLite schema, its supervision lockfile, its REST/MCP surface, its tracer sink) get their neond pointer **dropped** and a self-owned rationale; cite a neon API only where the choice is actually constrained by it.
- **Two intentional `neond` occurrences are permitted** after the sweep and whitelisted in verification: (a) the prohibition clause in the redefined AGENTS.md Oracle rule, and (b) the single historical footnote in `docs/phases-2-5-handover.md`. Everything else must be gone.
- Conventional commits; `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Work happens on branch `de-neond-references`.

---

### Task 1: Redefine the AGENTS.md Oracle rule (+ CLAUDE.md notes)

**Files:**
- Modify: `AGENTS.md` (the "Oracle rule" bullet under **Hard rules**)
- Modify: `CLAUDE.md` (any `neond` mention — the review-broker note, model-escalation examples, or Claude-specific notes)

**Interfaces:**
- Produces: the canonical citation convention (`// oracle: neon <…>`) and the redefined rule that Tasks 2–5 conform to. Read this task's result before doing the citation tasks.

- [ ] **Step 1 (RED): confirm the current neond-based rule is present**

Run: `grep -n "neond" AGENTS.md CLAUDE.md`
Expected: matches incl. AGENTS.md's `**Oracle rule:** engine interactions port ~/git/neond behavior …` and CLAUDE.md's oracle/broker/escalation references.

- [ ] **Step 2: replace the AGENTS.md Oracle rule**

Replace the existing Oracle-rule bullet with:

```markdown
- **Oracle rule:** Engine interactions (wire payloads, configs, protocol, CLI/args) are grounded in official **`neondatabase/neon`** — its engine source, HTTP APIs, `control_plane` (local orchestration), and `compute_tools`. Cite `// oracle: neon <path-or-endpoint>`. Reference pin: `neondatabase/neon @ 8f60b04` (clone locally to consult; provenance of DevDB's prototype origins is in `docs/phases-2-5-handover.md`). Do not invent payloads. **Product, orchestration, and storage-schema choices are DevDB's own** — no external oracle. Never depend on or reference `matisiekpl/neond`.
```

- [ ] **Step 3: sweep CLAUDE.md** — reword any `neond` mention (e.g. an oracle example) to reference official neon or drop it. Leave no `neond` in CLAUDE.md.

- [ ] **Step 4 (GREEN): verify only the intentional prohibition mention remains**

Run: `grep -n "neond" AGENTS.md CLAUDE.md`
Expected: exactly ONE match — the `Never depend on or reference \`matisiekpl/neond\`` clause in the new AGENTS.md rule. CLAUDE.md: no matches.

- [ ] **Step 5: commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs(oracle): redefine the oracle rule — official neondatabase/neon, not neond"
```

---

### Task 2: Re-point control-plane orchestration citations (`mgmt/service/branch.rs` + `project.rs`)

**Files (each has one or more `// oracle: … branch.rs/project.rs …` citations):**
- Modify: `packages/daemon/src/engine/pageserver-client.ts`
- Modify: `packages/daemon/src/engine/safekeeper-client.ts`
- Modify: `packages/daemon/src/engine/storcon-client.ts`
- Modify: `packages/daemon/src/services/branches.ts`
- Modify: `packages/daemon/src/services/projects.ts`
- Modify: `packages/daemon/src/services/timetravel.ts`
- Modify: `packages/daemon/src/state/repos.ts` (the `restore_swap` citation — **reframe as DevDB-own**)

**Neon authorities (pinned in `~/git/neon`):**
- Timeline create / create-at-LSN / info / delete → `pageserver/src/http/routes.rs` endpoints: `POST /v1/tenant/:tenant_shard_id/timeline`, `GET /v1/tenant/:tenant_shard_id/timeline/:timeline_id`, `DELETE …/timeline/:timeline_id`, and the OpenAPI contract in `pageserver/src/http/openapi_spec.yml`.
- Tenant create/delete + the storcon→pageserver proxy → `storage_controller/src/http.rs` (`POST /v1/tenant`) and `storage_controller/src/service.rs`.
- LSN-by-timestamp / restore sequencing → `pageserver` `…/timeline/:timeline_id/get_lsn_by_timestamp` + `control_plane/src/endpoint.rs` / `control_plane/src/neon_local.rs` (create/restore flow).
- Safekeeper timeline/tenant delete → `safekeeper/src/http` + `control_plane/src/safekeeper.rs`.

**Interfaces:** Consumes Task 1's citation convention. Produces nothing consumed by later tasks (independent cluster).

- [ ] **Step 1 (RED): list the citations to convert**

Run: `grep -rn "oracle:.*\(branch\.rs\|project\.rs\)" packages/daemon/src`
Expected: ~18 lines across the files above.

- [ ] **Step 2: exemplar rewrite (establish the pattern)**

In `pageserver-client.ts`, a citation currently reading:
```ts
// oracle: src/mgmt/service/branch.rs:141-152 (create), 675-701 (create at LSN).
```
becomes:
```ts
// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline (routes.rs; create + create-at-LSN via `ancestor_start_lsn`), contract in http/openapi_spec.yml.
```

- [ ] **Step 3: apply the pattern to the remaining branch.rs/project.rs citations** in the listed files, each pointing at the specific neon endpoint/file from **Neon authorities** above. Keep every existing `— note` about DevDB deviations (e.g. "no TLS") verbatim; only the source pointer changes.

- [ ] **Step 4: reframe the product-choice citation** in `state/repos.ts`. The `restore_swap` archive-row is DevDB's **own** SQLite-schema decision. Replace:
```ts
// oracle: src/mgmt/repository/branch.rs:251 restore_swap — archive old row under new
```
with:
```ts
// DevDB's own state model: on in-place restore we archive the prior branch row under the new timeline id (see TimeTravelService.swapOntoNewTimeline). Not an engine contract.
```

- [ ] **Step 5 (GREEN): verify the cluster is clean + behavior unchanged**

Run: `grep -rn "neond\|mgmt/service/branch\|mgmt/service/project\|mgmt/repository" packages/daemon/src/engine packages/daemon/src/services packages/daemon/src/state`
Expected: no matches.
Run: `pnpm --filter @devdb/daemon test`
Expected: 623 passed (0 behavior change).

- [ ] **Step 6: commit**

```bash
git add packages/daemon/src
git commit -m "docs(oracle): re-point branch/project citations to neon pageserver/storcon API"
```

---

### Task 3: Re-point engine-supervision citations (`daemon/mod.rs` + `daemon/pageserver/mod.rs` + tracer/lease)

**Files:**
- Modify: `packages/daemon/src/config.ts` (port constants; `preflight` TRACER_PORT)
- Modify: `packages/daemon/src/engine/boot.ts` (startup/shutdown order)
- Modify: `packages/daemon/src/engine/configs.ts` (identity.toml, pageserver/safekeeper/storcon config, trust-mode omissions)
- Modify: `packages/daemon/src/engine/tracer.ts` (**reframe as DevDB-own** sink)
- Modify: `packages/daemon/src/index.ts` (`lease/mod.rs` lockfile — **reframe as DevDB-own**)

**Neon authorities:**
- Local stack launch / supervision / startup-shutdown order → `control_plane/src/background_process.rs` (spawn+wait+signal), `control_plane/src/{pageserver,safekeeper,storage_controller,broker}.rs`, `control_plane/src/local_env.rs`, `control_plane/src/bin/neon_local.rs`.
- `identity.toml`, pageserver/safekeeper config keys, ports → `control_plane/src/pageserver.rs` / `safekeeper.rs` (they write these config files) + each binary's `--help`/config struct in `pageserver/src/config.rs`, `safekeeper/src/bin`.
- Trust-mode omissions (auth keys/JWT dropped) stay DevDB deviations — keep the note, re-point the *baseline* to the control_plane config that normally sets them.

- [ ] **Step 1 (RED):** `grep -rn "oracle:.*daemon/\(mod\|pageserver/mod\|tracer/mod\|lease/mod\)\.rs" packages/daemon/src` → ~15 lines.

- [ ] **Step 2: exemplar rewrite (supervision).** In `boot.ts`:
```ts
// oracle: startup order src/daemon/mod.rs:182-232
```
becomes:
```ts
// oracle: neon control_plane/src/bin/neon_local.rs start sequence + background_process.rs (spawn→wait-ready→next); DevDB order: storcon_db → broker → storcon → safekeeper → pageserver.
```

- [ ] **Step 3: apply to the remaining `daemon/mod.rs` + `pageserver/mod.rs` citations** in `config.ts`, `boot.ts`, `configs.ts`, pointing at the specific `control_plane/src/*.rs` file. Preserve every trust-mode `— note` verbatim.

- [ ] **Step 4: reframe the two DevDB-own citations.**
  - `tracer.ts`: the catch-all 127.0.0.1:4318 sink is DevDB's own (it absorbs the engine's OTLP export so a missing collector can't stall boot). Replace the neond pointer with: `// DevDB's own no-op OTLP sink so the engine's tracing export never blocks; the engine emits to TRACER_PORT (OTLP/HTTP default 4318).`
  - `index.ts`: the lockfile is DevDB's own supervision. Replace `// oracle: src/daemon/lease/mod.rs — exclusive-create lockfile` with `// DevDB's own single-instance guard: O_EXCL lockfile under the data dir (see index.ts boot/shutdown).`

- [ ] **Step 5 (GREEN):** `grep -rn "neond\|daemon/mod\|daemon/pageserver/mod\|daemon/tracer\|daemon/lease" packages/daemon/src` → no matches. Then `pnpm --filter @devdb/daemon test` → 623 passed.

- [ ] **Step 6: commit**

```bash
git add packages/daemon/src
git commit -m "docs(oracle): re-point engine-supervision citations to neon control_plane"
```

---

### Task 4: Re-point compute citations (`mgmt/compute/mod.rs`, SCRAM, pgconf, initdb)

**Files:**
- Modify: `packages/daemon/src/compute/manager.ts` (launch)
- Modify: `packages/daemon/src/compute/spec.ts` (generate_config / ComputeSpec)
- Modify: `packages/daemon/src/compute/pgconf.ts` (setup_pg_conf, pg_hba)
- Modify: `packages/daemon/src/compute/ports.ts` (sticky-then-random port)
- Modify: `packages/daemon/src/compute/scram.ts` (SCRAM + 32-alnum password)
- Modify: `packages/daemon/src/compute/builds/pgdistrib.ts` (`pg_distrib_dir` — already "upstream pageserver"; make it explicit neon)
- Modify: `packages/daemon/src/engine/embedded-postgres.ts` (`initdb`/postgres args, readiness needle)

**Neon authorities:**
- Compute launch, ComputeSpec, pgconf/pg_hba, port selection → `compute_tools/src/spec.rs` (`ComputeSpec`), `compute_tools/src/spec_apply.rs`, `compute_tools/src/config.rs`, `compute_tools/src/pg_helpers.rs`, `compute_tools/src/configurator.rs`; endpoint-side pgconf in `control_plane/src/postgresql_conf.rs` + `control_plane/src/endpoint.rs`.
- SCRAM-SHA-256 password + 32-char alphanumeric secret → the `postgres_protocol` crate's `password::scram_sha_256` as used by `compute_tools` role setup (`spec_apply.rs`); the 32-alnum generation is a DevDB choice — reframe as own, note SCRAM is the engine-required hash.
- `initdb` args / `--auth-*=scram-sha-256` / readiness "ready to accept connections" → `compute_tools`/`control_plane` initdb invocation; the needle string is stock Postgres.

- [ ] **Step 1 (RED):** `grep -rn "oracle:.*\(compute/mod\.rs\|password\.rs\|pg_hba\|initdb\|generate_config\|setup_pg_conf\)" packages/daemon/src` → ~7 lines.

- [ ] **Step 2: exemplar rewrite.** In `spec.ts`:
```ts
// oracle: src/mgmt/compute/mod.rs:820-917 generate_config.
```
becomes:
```ts
// oracle: neon compute_tools/src/spec.rs (ComputeSpec) + spec_apply.rs; DevDB emits the minimal spec compute_ctl consumes.
```

- [ ] **Step 3: apply to the remaining compute citations** in the listed files against the **Neon authorities**. Keep DevDB-deviation notes (no ssl block, no cert files, no TLS) verbatim. For `scram.ts`, split: SCRAM hash → `// oracle: neon — SCRAM-SHA-256 is the engine-required verifier (postgres_protocol::password::scram_sha_256, used in compute_tools spec_apply.rs)`; the 32-alnum length → `// DevDB's own secret policy: 32 alphanumerics.`

- [ ] **Step 4 (GREEN):** `grep -rn "neond\|mgmt/compute\|utils/password\|daemon/postgres" packages/daemon/src` → no matches. Then `pnpm --filter @devdb/daemon test` → 623 passed.

- [ ] **Step 5: commit**

```bash
git add packages/daemon/src
git commit -m "docs(oracle): re-point compute/scram/pgconf citations to neon compute_tools"
```

---

### Task 5: Docs sweep + historical footnote + final verification

**Files:**
- Modify: `README.md`, `docker/BINARIES.md`, `docs/phases-2-5-handover.md`, and any file under `docs/` still mentioning `neond`/`matisiekpl` (the design spec + feasibility research legitimately discuss neond-the-target — leave those; they are *about* cutting it).
- Modify: any remaining source comment surfaced by the final grep.

**Interfaces:** Consumes Tasks 1–4 (they clear the code citations). Produces the final grep-clean state.

- [ ] **Step 1 (RED): full-repo sweep to see what remains**

Run: `grep -rEni "neond|matisiekpl" --include="*.ts" --include="*.md" packages/ docs/ *.md docker/ | grep -v "docs/superpowers/specs/2026-07-06-devdb-de-neond\|docs/superpowers/research/2026-07-06-neond-cut\|docs/superpowers/plans/2026-07-06-devdb-de-neond"`
Expected: the AGENTS.md prohibition clause (intentional) + README/BINARIES.md/handover mentions still to fix.

- [ ] **Step 2: fix docs.** In `README.md` and `docker/BINARIES.md`, reword any "neond image / neond binaries" description to "the Neon engine (built from `neondatabase/neon`)" — factual, no neond. (The `FROM neond/neond` Dockerfile line is initiative A — **leave it**, and note that in Step 4's whitelist.)

- [ ] **Step 3: add the ONE historical footnote** to `docs/phases-2-5-handover.md`:
```markdown
> **Provenance note:** DevDB was prototyped against `matisiekpl/neond` (a third-party "Neon-based control plane") as a working example. That dependency has been cut — engine facts now cite official `neondatabase/neon`, and product decisions are DevDB's own. The binary-supply cut (`FROM neond/neond`) is tracked separately as initiative A.
```

- [ ] **Step 4 (GREEN): final whitelist verification**

Run: `grep -rEni "neond|matisiekpl" packages/ docs/ *.md docker/`
Expected — ONLY these intentional occurrences:
  1. `AGENTS.md` — the Oracle-rule prohibition clause.
  2. `docs/phases-2-5-handover.md` — the provenance footnote.
  3. `docker/Dockerfile` — `FROM neond/neond@sha256:…` (initiative A; explicitly deferred).
  4. `docs/superpowers/{specs,research,plans}/2026-07-06-*` — the de-neond design/plan/research (they are *about* the cut).
Any other match is a miss — fix it.
Run: `pnpm --filter @devdb/daemon test` → 623 passed.

- [ ] **Step 5: commit**

```bash
git add -A
git commit -m "docs: sweep remaining neond references; add provenance footnote"
```

---

## Divergence notes (filled during execution; NOT acted on)

*(If re-pointing a citation reveals DevDB's behavior appears to differ from neon's, record it here as one line — `file:line — DevDB does X, neon does Y` — for a possible future initiative. Do not change behavior.)*

- `services/timetravel.ts:~138` (`classifyLsnRangeError`) — DevDB reclassifies engine LSN-range failures to HTTP **400** for a client-actionable PITR-range message; neon's pageserver returns **406 Not Acceptable** for `CreateTimelineError::AncestorLsn`/`AncestorArchived` (`pageserver/src/http/routes.rs:693-702`; `AncestorNotActive` is 503, excluded from the claim). Deliberate DevDB remap, not a bug — recorded for provenance. (Task 2)

---

## Self-review

**Spec coverage:** ✅ 48 `// oracle:` citations (Tasks 2–4) · ✅ AGENTS.md rule redefinition (Task 1) · ✅ CLAUDE.md (Task 1) · ✅ docs/comment sweep (Task 5) · ✅ historical footnote (Task 5) · ✅ engine-facts→neon + product-choices→DevDB-own split (Tasks 2–4 reframes) · ✅ verification = grep-clean + daemon green (every task).

**Refinement vs spec:** the spec said "one permitted occurrence"; this plan permits **two** intentional ones (the AGENTS.md rule prohibition + the handover footnote) plus the deferred `FROM neond/neond` Dockerfile line and the de-neond docs themselves. Flagged for the user.

**No placeholders:** each citation task names the exact neon authority file/endpoint + gives an exemplar before→after; no "find the equivalent" without a named target.

**Consistency:** citation format (`// oracle: neon <path-or-endpoint>`) is identical across Tasks 1–4; the reference pin `neon@8f60b04` matches the spec.
