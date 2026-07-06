# Project rename: DevDB → Worktree DB  (+ planned Go rewrite)

**Date:** 2026-07-06 · **Status:** decided (Jordan), not yet executed · **Owner:** Jordan

## The rename

The project is being renamed **DevDB → "Worktree DB."** The name makes the core metaphor explicit — *worktree : files :: branch : data*. All **new** code and published artifacts use the new name from the start; the existing TypeScript daemon + docs keep "DevDB" until the Go rewrite (below) renames them wholesale — we do **not** mass-rename piecemeal now.

## The Go rewrite

Jordan is rewriting the daemon (currently TypeScript / Node 22 / Fastify) in **Go**, short-term. The rewrite will:
- Reimplement the daemon — state/SQLite, engine supervision, compute lifecycle, services, HTTP + MCP, and the dynamic-pg-build **OCI pull client** — in Go.
- Adopt the **Worktree DB** name throughout.
- Live under a root Go module: **`github.com/<org>/worktree-db`** (`<org>` TBD until the repo is pushed to GitHub).

## What already reflects the rename (starting with initiative A)

- **Build tooling is Go, named for Worktree DB.** Initiative A's from-source Neon build CLI is Go at **`cmd/worktree-build/`**, module **`github.com/<org>/worktree-db`** — the *first* Go code in the repo, seeding the rewrite.
- The pipeline's **published engine images** use the new name: `ghcr.io/<org>/worktree-neon-engine`, `ghcr.io/<org>/worktree-compute-v{N}`.

## What still says "DevDB" (renamed at rewrite time, not now)

- The TypeScript daemon (`packages/daemon`), web UI (`packages/web`), the `devdb:dev` runtime image, and all existing docs/specs/plans (including the initiative-A spec/plan, which describe the current-state project). These get renamed as one coherent pass during the Go rewrite.

## Roadmap implications

- **Initiative A's build *pipeline*** (the from-source `neon-build/Dockerfile`) is **language-agnostic and rewrite-proof** — it compiles Neon (Rust) + Postgres (C) regardless of the daemon's language, so it proceeds now (with the tooling authored in Go).
- **Initiative A's daemon-side repoint** (`oci.ts` config → GHCR) is **deferred into the Go rewrite** — the Go pull client targets GHCR from the start; no effort is spent rewiring the about-to-be-replaced TS `oci.ts`.
- **Phases 4–5** (import/export + durability; extensions/platform) will be built as **Worktree DB in Go**.
