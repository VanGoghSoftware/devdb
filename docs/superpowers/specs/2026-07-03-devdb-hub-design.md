# DevDB Hub — Design Spec

**Date:** 2026-07-03
**Status:** Approved design, **parked** — future feature, earliest slot phase 6. This doc is the deliverable; write its implementation plan (superpowers:writing-plans) only when the feature is scheduled.
**Depends on:** phase 4 (import/export pipelines are the push/pull engine); rides on phase 2 (fork context in manifests, MCP surface) and phase 3 (UI kit).
**Parent spec:** `docs/superpowers/specs/2026-07-02-devdb-design.md`.

## Product statement

DevDB Hub is a self-hosted registry where a team shares complete databases and forks between their local DevDB instances — "Docker Hub for databases." A member (or their agent) pulls the team's canonical dataset in one call and forks it locally; pushing a branch shares its exact state with lineage back to what it was forked from. The Hub stores artifacts and truths about them; it never runs Postgres and never sees the storage engine.

## Goals (staged)

1. **Hub stage 1 — Golden datasets:** teams maintain canonical databases (anonymized prod snapshots, seed sets, staging state) as hub repositories; members and agents pull and fork locally. Push/pull, tags, token auth, catalog web UI, MCP tools + skill.
2. **Hub stage 2 — Handoff:** "my agent broke on this exact state — grab my fork": one-call personal shares with TTL + auto-prune, pull-by-reference, optional webhook notification.
3. **Hub stage 3 — Lineage & insight:** team-wide fork-graph UI over the parent-pointer DAG; schema-diff summaries between parent and child versions (computed client-side at push).
4. **Hub stage 4 (optional future) — Layer transport:** engine-native layer bundles as a second artifact format (near-instant pulls, incremental fork pushes); possible evolution toward a hub-side live engine ("Mirror"). Catalog model unchanged.

## Non-goals (hub v1)

- Public/anonymous sharing (every request is authenticated; there is no public mode).
- Multi-org/multi-team on one hub; SSO/OIDC; passwords (identity = named members + tokens).
- Client-side/E2E encryption (considered, rejected: key distribution kills the one-call UX; encryption at rest is the storage backend's job — revisit on demand).
- Engine-layer transport and hub-side computes (stage 4 / Mirror — explicitly out of v1).
- Sub-artifact dedup, retention policies beyond handoff TTL, cross-hub replication.

## Decisions log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | All three use cases (golden datasets, handoff, lineage), staged; stage 1 is the must-work core |
| 2 | Form factor | Self-hosted hub server: one `devdb-hub` Docker container + storage backend (SaaS later = us hosting the same container) |
| 3 | Wire format | `pg_dump -Fc` artifacts in v1 (reuses phase-4 pipelines); engine-native layer bundles parked as stage 4 transport optimization |
| 4 | Identity | One hub = one team; named members with personal access tokens (agents use their owner's token); roles `admin|member`; no passwords/SSO |
| 5 | Architecture | Registry model (repos → immutable versions → movable tags; lineage as metadata graph) — over "Mirror" (live engine on hub) and "git-remote" (thin server) |
| 6 | Stack | Same as daemon: Node 22 + Fastify + SQLite (WAL) + embedded React/Mantine UI; separate image `devdb-hub` |
| 7 | Blob storage | Pluggable: S3, Azure Blob, MinIO, local disk (tiny teams: one volume, no bucket); content-addressed `blobs/sha256/<digest>` |
| 8 | TLS | Hub is network-exposed by design: HTTP behind the team's reverse proxy (Caddy/Traefik/nginx), optional built-in `HUB_TLS_CERT/KEY` |

## Concepts

- **Hub** — one team's registry instance. Single-org by definition; "a hub IS a team."
- **Repository** — a named shareable database line. Kinds: `dataset` (team-canonical, root namespace, name `[a-z0-9-]{1,64}`) and `handoff` (personal, namespaced `<member>/<slug>`, default TTL 14 days, auto-pruned). Management: any member creates/pushes; delete/tag-move on a dataset = its owner or an admin; a handoff belongs to its member (plus admins).
- **Version** — immutable artifact: a content-addressed `pg_dump -Fc` blob + manifest: PG major, size, source LSN, pusher identity, source project/branch names, the branch's **fork context** (per the 2026-07-03 parent-spec amendment), and an optional **parent pointer** (`repo@digest` it was forked from). Addressing: `repo:tag` or `repo@sha256:…`.
- **Tag** — movable pointer within a repo (`latest`, `sprint-42`). Tags move; versions never change.
- **Lineage** — the DAG over versions formed by parent pointers. Bytes are full copies in v1; ancestry is first-class metadata and survives a later layer transport unchanged.
- **Provenance (client-side)** — a branch pulled from the hub records `{hub, repo, digest}` locally. When that branch (or a fork of it) is later pushed, the client proposes the parent pointer automatically — lineage falls out of pull→fork→push, nobody curates it by hand.

## Hub server architecture

One container, one mounted volume (SQLite catalog + local-disk blobs when no bucket is configured).

**Catalog (SQLite, WAL, additive migrations — same discipline as the daemon):**

- `members` (id, name, role `admin|member`, disabled, created_at)
- `tokens` (id, member_id, name, token_hash, created_at, last_used_at, revoked_at) — hashed at rest, plaintext shown exactly once
- `repos` (id, name, kind `dataset|handoff`, owner_member_id, description, ttl_days nullable — handoff default 14, created_at)
- `versions` (id, repo_id, digest, size_bytes, pg_major, source_lsn, manifest_json, parent_version_id nullable FK, parent_external nullable text — `repo@digest` string kept when the actual parent row is gone, pushed_by, created_at)
- `tags` (repo_id, name, version_id, updated_at, updated_by; UNIQUE(repo_id, name))
- `upload_sessions` (id, repo_id, member_id, state, created_at, expires_at)

**API (`/api/v1`, bearer token on every request):**

- Repos: `POST /repos` `{name, kind, description?, ttl_days?}` · `GET /repos?kind=&q=` · `GET|DELETE /repos/:name`
- Push: `POST /repos/:name/uploads` → upload session · `PUT /uploads/:id` (streamed body; hub hashes while streaming to the backend) · `POST /uploads/:id/complete` `{digest, manifest}` — hub verifies the digest **before** the version becomes visible; expired/abandoned sessions never surface and a GC sweeps orphaned blobs
- Pull: `GET /repos/:name/versions` · `GET /versions/:digest` (manifest) · `GET /repos/:name/blob?ref=<tag|digest>` → 302 to a presigned URL where the backend supports it, streamed through the hub otherwise
- Tags: `PUT /repos/:name/tags/:tag` `{digest}` · `DELETE /repos/:name/tags/:tag`
- Admin: members CRUD, token mint/revoke · `GET /whoami` · `GET /health`
- Stage 3: `GET /lineage?root=<repo@digest>` (the fork graph)

**Bootstrap:** first boot creates the admin member and prints a one-time admin token to container logs; the admin then creates named members and their tokens in the UI.

**Web UI (embedded, React/Mantine):** catalog browse/search; repo page (versions, tags, lineage snippet, copy-pull command); member/token admin (admin role); login = paste a token. Stage 3 adds the global fork-graph view.

## Local DevDB integration

- **Hub registration:** hubs configured in the local daemon (name, URL, token) — modeled as a list, stored in local state (`settings`); token handled like existing local secrets.
- **Push** = phase-4 export pipeline with a new target kind `hub` (stream dump → upload session → manifest with LSN, PG major, fork context, auto-proposed parent from provenance). **Pull** = phase-4 import pipeline from a hub blob (download → `pg_restore` into a fresh branch → record provenance). Both are async **jobs** with SSE-streamed progress and stderr tails on failure — the existing `jobs` table and log channels.
- **Local state:** additive migration adds branch provenance (`origin` JSON: hub, repo, digest) alongside the fork-context column.
- **REST (local daemon):** `GET|POST|DELETE /api/hubs` · `POST /api/branches/:id/hub-push` `{hub, repo, tag?}` → job · `POST /api/projects/:id/hub-pull` `{hub, repo, ref?, branch_name?}` → job.
- **MCP tools:** `hub_list {hub?, repo?}`, `hub_pull {hub?, repo, ref?, project, branch_name?}` (**auto-starts endpoint, returns connstring** — an agent gets the team's canonical data in one call), `hub_push {project, branch, repo, tag?}`; stage 2 adds `hub_share {project, branch}` sugar (auto-named handoff repo, fork context attached). Tool responses follow the parent spec's context-line and next-step-hint principles.
- **Skill:** `using-devdb-hub` — pull golden data instead of inventing seed data; push forks with a purpose line; handoff etiquette (TTL, naming); never push databases containing real secrets/PII unless team policy explicitly allows.
- **Local UI:** hub section in settings; "pull from hub" in project view; "push to hub" in branch panel; provenance chip on pulled branches (pairs with the fork-context chip).

## Security

- Every request authenticated; tokens hashed at rest, shown once, revocable per token; `last_used_at` visible to admins.
- Artifact integrity: sha256 computed client-side, verified hub-side on push and client-side on pull.
- Stated plainly in user docs: artifacts are **cleartext dumps** on the hub's storage; handing someone hub access hands them the data. Encryption at rest = backend SSE/disk encryption; TLS in transit per decision 8.
- The local daemon's localhost-trust posture is unchanged; the hub is the network-facing component and carries the auth.

## Error handling

- Transfer failure → job `failed` with stderr/HTTP-error tail preserved; retry re-runs the whole transfer (single-stream dumps; multipart resume is later hardening).
- Digest mismatch → upload rejected, version never visible.
- Deleting a version with children → refused, children listed (mirrors local branch-delete rules); `force` moves children's pointers to `parent_external` instead of erasing lineage.
- PG-major mismatch on pull → error names artifact and project majors, suggests creating a matching project.
- Hub unreachable/misconfigured → local hub features degrade to absent; core DevDB unaffected.
- Handoff TTL expiry → repo pruned by hub GC; pulls of pruned refs return a clear "expired handoff" error.

## Testing

- **Unit:** hub services and local hub client against typed fakes (same no-`as any` discipline, tsc-gated).
- **Integration (testcontainers):** hub container + each blob backend (MinIO, Azurite, local disk); **two DevDB instances sharing one hub** — push from A, pull into B, verify data equality, provenance, lineage; token-denial paths; digest-tamper test; handoff TTL prune.
- **MCP contract:** SDK client drives `hub_pull`/`hub_push` end-to-end in the integration tier.

## Acceptance (demo script)

1. `docker compose -f docker/hub-compose.yaml up` (hub + MinIO) → hub UI on its port; admin token printed once; admin creates member "jordan" + token.
2. DevDB instance A registers the hub, pushes `staging-snapshot:latest` from a branch (manifest carries LSN + fork context).
3. On DevDB instance B, an agent runs `hub_pull staging-snapshot` via MCP → gets a connection string in one call → forks locally and works destructively; A's data unaffected.
4. B pushes its fork; hub UI shows the version with a parent pointer to A's artifact (lineage chain rendered).
5. Jordan pushes a handoff share (`jordan/repro-cart-bug`); a teammate pulls it by reference; 14 days later it auto-prunes.
6. Pull the artifact with plain `curl` + `pg_restore` into vanilla Postgres — artifacts stay portable.

## Risks & open questions (resolve in the phase plan)

1. **Upload resume** — v1 retries whole transfers; decide the multipart/resumable protocol when real artifact sizes are known.
2. **Presigned-URL support matrix** — which backends redirect vs stream-through (local disk always streams); measure hub throughput as the proxy.
3. **Schema-diff tooling** (stage 3) — client-side diff implementation (migra-style vs pg_dump -s text diff) to be chosen from what's available in-image.
4. **Webhook shape** (stage 2) — generic POST vs Slack-formatted; keep minimal.
5. **Hub UI code sharing** — whether `packages/hub` reuses components from `packages/web` (extract a shared UI lib only if it stays cheap).
6. **Repo layout confirmation** — `packages/hub` (server + embedded UI), hub client inside the daemon (`services/hub.ts` behind an engine-api-style interface), manifest zod schemas in `packages/shared`, `docker/hub.Dockerfile` + `docker/hub-compose.yaml`.
