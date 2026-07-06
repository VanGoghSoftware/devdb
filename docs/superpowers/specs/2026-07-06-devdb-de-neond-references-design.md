# De-neond References — Design Spec

**Status:** approved design (brainstormed 2026-07-06), pending implementation plan.
**Goal:** Remove every reference to the third-party `matisiekpl/neond` project from the DevDB codebase and docs, and redefine DevDB's engine-interaction "oracle" as official `neondatabase/neon`. **No runtime behavior changes.**

## Context & motivation

DevDB was prototyped using **neond** (`matisiekpl/neond` — a third-party, solo-maintainer "Neon-based control plane") as a *working example* of the product we're building. neond served its purpose. Two dependencies on it remain:

1. **Binaries / containers** — the Docker image bakes the entire Neon engine `FROM neond/neond@sha256:e940…`. This is the **binary-supply cut**, tracked as a **separate follow-on initiative ("A")** — *out of scope here*.
2. **References** — 48 `// oracle: <neond path>` citations across `packages/*/src`, the AGENTS.md "Oracle rule" that mandates porting neond behavior, and assorted doc mentions.

This spec covers (2): **de-referencing neond**. Jordan's directive is explicit: *what we've built is fine and must NOT be re-evaluated.* This is a provenance/reference cleanup, **not a correctness audit**. From here on, the only external authority is official `neondatabase/neon`.

## The redefined oracle model (centerpiece)

Today's AGENTS.md rule — *"engine interactions port ~/git/neond behavior with cited // oracle: comments … Do not copy neond's UI"* — conflates two very different things. Split them:

- **Engine-interaction facts** — wire payloads, configs, ports, SCRAM, `initdb` args, the pageserver / storage_controller / safekeeper HTTP endpoints, compute_ctl's ComputeSpec. These have a **real external authority**, and it was *always* **Neon's engine**, never neond — neond merely showed us where to look. The engine rejects a wrong payload regardless of neond. → **Oracle = official `neondatabase/neon`** (engine source + HTTP APIs + `control_plane` + `compute_tools`).
- **Product / orchestration / implementation choices** — how DevDB sequences branch create/restore, its SQLite state schema, its REST/MCP surface, what it exposes. These have **no external oracle** — they are **DevDB's own decisions**. neond was one example of the product shape; DevDB has made its own choices.

**New rule (replaces the AGENTS.md "Oracle rule"):**

> **Oracle rule:** Engine interactions (wire payloads, configs, protocol, CLI/args) are grounded in official **`neondatabase/neon`** — its engine source, HTTP APIs, `control_plane` (local orchestration), and `compute_tools`. Cite `// oracle: neon <path-or-endpoint>`; the reference commit is recorded below. Do not invent payloads. **Product, orchestration, and storage-schema choices are DevDB's own** — no external oracle. Never depend on or reference `matisiekpl/neond`.

**Reference pin:** `neondatabase/neon @ 8f60b04` (2026-05-25) — cloned to `~/git/neon` (shallow, no submodules). A recent commit suffices: citations reference *stable* neon subsystems/endpoints (provenance), not exact lines (we are not re-verifying behavior), so version drift is immaterial. Confirmed present at this commit: `control_plane`, `compute_tools`, `pageserver/src/http`, `storage_controller/src`, `safekeeper/src`.

## Scope

**In scope:**
- Re-point / reframe all **48 `// oracle:` citations** in `packages/*/src` (+ any in tests).
- **Redefine the AGENTS.md "Oracle rule"** (and the CLAUDE.md notes, if any reference neond).
- **Sweep every remaining `neond` / `matisiekpl` / `~/git/neond` mention** in docs (README, `docker/BINARIES.md`, `docs/phases-2-5-handover.md`, `docs/superpowers/*`) and code comments — re-point to neon or remove, EXCEPT one intentional historical footnote (below).
- **Verification:** `grep -rEi "neond|matisiekpl"` returns only the intentional footnote; the daemon suite stays green.

**Out of scope (explicit):**
- **No behavior changes.** Comments + docs only. If the sweep incidentally surfaces a suspected divergence from neon, it is **noted as a finding, never fixed here** (per "don't re-evaluate what we built").
- **The binary-supply cut (initiative A)** — the `FROM neond/neond` Dockerfile line and re-sourcing engine binaries from neon images. Separate follow-on spec.

## Category mapping (neond subsystem → neon authority)

| neond source cited today | count | Neon authority to cite instead |
|---|---|---|
| `mgmt/service/branch.rs`, `project.rs` | 16 | storage_controller / pageserver **HTTP API** (the endpoints we call) + `control_plane` create/delete/restore sequencing |
| `daemon/mod.rs`, `daemon/pageserver/mod.rs` | 12 | `control_plane` (local stack launch order/config) + each binary's CLI |
| `compute/mod.rs`, scram, pgconf, pg_hba | 5 | `compute_tools` (compute_ctl, ComputeSpec, pgconf / pg_hba generation) |
| engine-intrinsic facts (TRACER_PORT, SCRAM alphabet, `identity.toml`, port constants) | ~4 | neon engine source directly |
| `mgmt/repository/branch.rs` `restore_swap`, `mgmt/model/branch.rs` conn-string, other product/impl choices | ~few | **reframed as DevDB's own** (neond pointer dropped; cite the constraining neon API only where relevant) |

Exact per-citation resolution is the plan's work, done against the `~/git/neon` clone.

## Method

- **Category-batched:** resolve each neon subsystem's authority *once*, then apply across all its citations. The 48 cluster into ~6 groups, so this avoids 48 independent lookups and keeps citation style consistent.
- **Granularity:** cite neon at **file + symbol / endpoint** level (e.g. `neon control_plane/src/endpoint.rs → EndpointConf`, `neon pageserver PUT /v1/tenant/:id/timeline`), **not** exact line numbers — provenance, not verification, and neon moves.
- **Product-choice citations:** rewrite to state the decision as DevDB's own, dropping the neond pointer; reference the underlying neon engine API only where the choice is constrained by it.
- **Reference:** `~/git/neon` shallow clone; commit recorded in the redefined rule.

## Verification

- `grep -rEi "neond|matisiekpl" packages/ docs/ *.md` → empty except the intentional historical footnote.
- `pnpm --filter @devdb/daemon test` green (zero behavior change — comments + docs only).
- The full integration suite is not required (no behavior change); a spot `docker build` stays green since only comments/docs changed.

## Intentional historical footnote

A single sentence — in `docs/phases-2-5-handover.md` — records that DevDB was prototyped against neond as a working example and has since cut all dependence on it. This preserves the provenance (so a future reader doesn't "rediscover" neond and re-introduce it) while removing every *live* reference. It is the one permitted occurrence of the word.

## Follow-on: initiative A (binary-supply cut)

A separate spec. Re-source the engine binaries directly from neon images (`neondatabase/neon` for storage, `neondatabase/compute-node-v{N}` for compute), handle mixed Debian bases (v14–v16 bullseye, v17 + storage bookworm — ties to the deferred self-contained lib-bundling fix), and close the `vanilla_v17` gap (plain non-forked Postgres hosting storage_controller's catalog DB; no pullable artifact → build-from-source or substitute stock Postgres). Feasibility research: `docs/superpowers/research/2026-07-06-neond-cut-feasibility.md`.
