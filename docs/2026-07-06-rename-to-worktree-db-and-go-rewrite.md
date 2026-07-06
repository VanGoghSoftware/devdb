# Project rename: DevDB → Worktree DB  (+ planned Go rewrite, two-repo clean-history plan)

**Date:** 2026-07-06 · **Status:** decided (Jordan), not yet executed · **Owner:** Jordan · **Org:** `VanGoghSoftware`

## The rename

The project is being renamed **DevDB → "Worktree DB."** The name makes the core metaphor explicit — *worktree : files :: branch : data*.

- **Display / product name:** **Worktree DB** (two words).
- **Code identifier:** **`worktreedb`** (one word, lowercase). Deliberately NOT `worktree` — that word alone is a common git term and would collide/confuse in code, package names, and image tags.

## The two repos + clean-history plan

- **Current repo — `github.com/VanGoghSoftware/devdb`** — the existing **TypeScript** codebase (Node/Fastify daemon + React web). Keeps its full history. This is where initiative A's build pipeline is developed *now*.
- **Future repo — `github.com/VanGoghSoftware/worktreedb`** — the **Go rewrite** lands here, in a **fresh repo with CLEAN git history — no trace of the TypeScript code.** That separation is the whole reason for two repos: worktreedb starts clean, not carrying the TS lineage.
- Because the Go code will move to `worktreedb`, the Go written now uses module path **`github.com/VanGoghSoftware/worktreedb`** from the start — so it's move-ready and needs no import rewrite when it's copied into the fresh repo.

## The Go rewrite

Jordan is rewriting the daemon (currently TypeScript / Node 22 / Fastify) in **Go**, short-term. The rewrite will:
- Reimplement the daemon — state/SQLite, engine supervision, compute lifecycle, services, HTTP + MCP, and the dynamic-pg-build **OCI pull client** — in Go.
- Adopt the **Worktree DB** name throughout (code identifier `worktreedb`).
- Live under root module **`github.com/VanGoghSoftware/worktreedb`** in the clean `worktreedb` repo.

## What already reflects the rename (starting with initiative A)

- **Build tooling is Go, module `github.com/VanGoghSoftware/worktreedb`.** Initiative A's from-source Neon build CLI is Go at **`cmd/worktreedb-build/`** — the *first* Go code, seeding the rewrite. (It lives in the `devdb` repo temporarily; it moves to `worktreedb` with the rewrite. Using the future module path now keeps it move-ready.)
- The pipeline's **published engine images** use the new name + org: `ghcr.io/vangoghsoftware/worktreedb-neon-engine`, `ghcr.io/vangoghsoftware/worktreedb-compute-v{N}`.

## What still says "DevDB" (renamed at rewrite time, not now)

- The TypeScript daemon (`packages/daemon`), web UI (`packages/web`), the `devdb:dev` runtime image, and all existing docs/specs/plans (including the initiative-A spec/plan, which describe the current-state project). These get renamed as one coherent pass during the Go rewrite — or simply not carried into the clean `worktreedb` repo.

## Roadmap implications

- **Initiative A's build *pipeline*** (the from-source `neon-build/Dockerfile`) is **language-agnostic and rewrite-proof** — it compiles Neon (Rust) + Postgres (C) regardless of the daemon's language, so it proceeds now (tooling authored in Go as `worktreedb`).
- **Initiative A's daemon-side repoint** (`oci.ts` config → GHCR) is **deferred into the Go rewrite** — the Go pull client targets GHCR from the start; no effort spent rewiring the about-to-be-replaced TS `oci.ts`.
- **Phases 4–5** (import/export + durability; extensions/platform) are built as **Worktree DB in Go**, in the clean repo.
