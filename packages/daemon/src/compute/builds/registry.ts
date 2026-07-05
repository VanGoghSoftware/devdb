import { readdir, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DevdbError } from "../../services/errors.js";
import type { StateDb } from "../../state/db.js";
import type { PgBuildRow } from "../../state/repos.js";

interface BuildMarker { digest: string; tag: string; major: number; minor: number; extractedAt: string }

// The first 16 hex chars of a sha256 image digest — the content-address component used for a
// downloaded build's directory name (`v{major}/{shortDigest}`, `.tmp-{shortDigest}` while
// extracting) and its adopted-row id (`dl-{major}-{shortDigest}`). Tags are NOT identity: a
// mutable tag (`latest`) re-pulled at a newer digest must land in a new dir beside the old one.
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 16);
}

// FIX-6: validate a build.json marker's SHAPE before trusting any field — a raw cast would let a
// malformed-but-parseable marker insert undefined major/minor. Callers additionally check the marker
// against its on-disk location (dir==shortDigest, major==vN) and re-detect the binary version.
function parseMarker(raw: string): BuildMarker {
  const m = JSON.parse(raw) as Record<string, unknown>;
  if (typeof m.digest !== "string" || !/^sha256:[0-9a-f]+$/.test(m.digest)) throw new Error("marker.digest is not a sha256 hex digest");
  if (typeof m.tag !== "string") throw new Error("marker.tag is not a string");
  if (typeof m.major !== "number" || !Number.isInteger(m.major)) throw new Error("marker.major is not an integer");
  if (typeof m.minor !== "number" || !Number.isInteger(m.minor)) throw new Error("marker.minor is not an integer");
  if (typeof m.extractedAt !== "string") throw new Error("marker.extractedAt is not a string");
  return { digest: m.digest, tag: m.tag, major: m.major, minor: m.minor, extractedAt: m.extractedAt };
}

function versionString(row: PgBuildRow): string {
  return `${row.major}.${row.minor}`;
}

// Active-build preference, shared by resolveActives (every major, at boot) and resolveActiveFor
// (a single major, failure recovery): newest minor wins; a tie goes to the baked build (its minor
// came from a real --version probe at seed time, so it's the trusted default). Kept in one place
// so the two callers can never drift into electing different winners for the same candidate set.
function byActivePreference(a: PgBuildRow, b: PgBuildRow): number {
  return (b.minor! - a.minor!) || ((a.source === "baked" ? -1 : 1) - (b.source === "baked" ? -1 : 1));
}

export class BuildRegistry {
  private degraded = new Set<number>();

  constructor(private deps: {
    state: StateDb; pgInstallDir: string; pgBuildsDir: string;
    detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>;
    logger: { info(m: string): void; error(m: string, e?: unknown): void };
  }) {}

  // Scans pgInstallDir for v<digits> dirs (skipping vanilla_* — the storcon-internal postgres,
  // not a tenant version). Detects each baked dir's version EVERY boot and upserts a stable
  // baked-v{major} row.
  //
  // FIX-2 (final whole-branch review): this used to skip any existing baked-v{major} row on the
  // premise "a baked minor cannot change without a new image" — but a NEW IMAGE ON THE PERSISTED
  // VOLUME is the supported upgrade path (README). A stale row then (a) feeds recordRun the old
  // minor while the real binary + neon catalog on disk are newer, and (b) lets a later explicit
  // activate of an equal-minor downloaded build pass the downgrade guard while genuinely
  // downgrading past the catalog. So existing rows are RE-PROBED: minor drift is written back
  // (repo updateMinor), a previously-failed row whose dir returned is resurrected to ready, a row
  // whose probe fails is marked failed (never crash boot for a row we can mark instead), and —
  // the trailing pass — a baked row whose install dir VANISHED (the image dropped that major) is
  // failed rather than left as a zombie ready+active row with a dangling path (the downloaded-row
  // presence sweep in adoptVolumeBuilds never looks at baked rows).
  async seedBaked(): Promise<void> {
    const entries = await readdir(this.deps.pgInstallDir).catch(() => [] as string[]);
    const seen = new Set<string>();
    for (const name of entries) {
      const m = /^v(\d+)$/.exec(name);
      if (!m) continue; // also excludes vanilla_v17 etc.
      const path = join(this.deps.pgInstallDir, name);
      const id = `baked-${name}`;
      seen.add(id);
      const existing = this.deps.state.pgBuilds.byId(id);
      if (existing) {
        try {
          const { major, minor } = await this.deps.detectVersion(join(path, "bin", "postgres"));
          // FIX-6 symmetry: a baked dir whose binary now reports a DIFFERENT major than its vN dir
          // name is a mislabeled/swapped install — fail it rather than keep the stale (dir) major.
          if (major !== Number(m[1])) throw new Error(`baked binary major ${major} != dir v${m[1] ?? "?"}`);
          if (existing.minor !== minor) this.deps.state.pgBuilds.updateMinor(id, minor);
          if (existing.status !== "ready") this.deps.state.pgBuilds.setStatus(id, "ready");
        } catch (e) {
          this.deps.state.pgBuilds.setStatus(id, "failed", "baked build failed version re-probe at boot");
          this.deps.logger.error(`baked build at ${path} failed version re-probe`, e);
        }
        continue;
      }
      const { major, minor } = await this.deps.detectVersion(join(path, "bin", "postgres"));
      this.deps.state.pgBuilds.insert({
        id, major, minor, source: "baked", releaseTag: "baked", imageDigest: "", path, status: "ready",
      });
    }
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.source !== "baked" || seen.has(row.id) || row.status === "failed") continue;
      this.deps.state.pgBuilds.setStatus(row.id, "failed", "baked build dir missing at boot");
    }
  }

  // Re-inserts registry rows from build.json markers under pgBuildsDir/v*/<shortDigest>/ (skipping
  // .tmp-* — in-progress installs). FIX-6: the marker is SHAPE-validated (parseMarker) and checked
  // for CONSISTENCY against its on-disk location — the dir basename must equal shortDigest(digest)
  // AND the marker's major must equal the vN dir — then the binary version is RE-DETECTED and the
  // DETECTED major/minor adopted (a marker is never trusted to name the version; symmetric with
  // seedBaked). Any shape/consistency/version disagreement skips the dir with a logged reason rather
  // than surfacing a wrong-version ready build. A dir already tracked by an existing row (a
  // pull-created row keeps its UUID id, not the dl- form) is skipped by a path claim check: without
  // it every boot would re-adopt pulled dirs as duplicate rows sharing one path, and a later
  // GC/remove of the duplicate would rm the live build's directory. Rows whose backing dir has
  // vanished since the last adopt are marked failed via a presence check on bin/postgres.
  async adoptVolumeBuilds(): Promise<void> {
    const claimedPaths = new Set(this.deps.state.pgBuilds.list().map((r) => r.path));
    const majors = await readdir(this.deps.pgBuildsDir).catch(() => [] as string[]);
    for (const vdir of majors) {
      if (!/^v\d+$/.test(vdir)) continue;
      const entries = await readdir(join(this.deps.pgBuildsDir, vdir)).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry.startsWith(".tmp-")) continue;
        const path = join(this.deps.pgBuildsDir, vdir, entry);
        if (claimedPaths.has(path)) continue;
        try {
          const marker = parseMarker(await readFile(join(path, "build.json"), "utf8"));
          // Consistency with the on-disk location: the dir basename IS the content-address, and the
          // marker's major IS the vN dir. A disagreement means a corrupt/renamed/tampered install.
          if (shortDigest(marker.digest) !== entry) throw new Error(`marker digest ${shortDigest(marker.digest)} != dir ${entry}`);
          if (marker.major !== Number(vdir.slice(1))) throw new Error(`marker major ${marker.major} != dir ${vdir}`);
          const id = `dl-${marker.major}-${shortDigest(marker.digest)}`;
          if (this.deps.state.pgBuilds.byId(id)) continue;
          // Re-detect from the BINARY (this postgres --version subsumes the old access() probe) and
          // adopt the DETECTED version. A binary whose major disagrees with its marker is not trusted
          // — reject rather than surface a wrong-version ready+active build.
          const detected = await this.deps.detectVersion(join(path, "bin", "postgres"));
          if (detected.major !== marker.major) throw new Error(`binary major ${detected.major} != marker major ${marker.major}`);
          this.deps.state.pgBuilds.insert({
            id, major: detected.major, minor: detected.minor, source: "downloaded",
            releaseTag: marker.tag, imageDigest: marker.digest, path, status: "ready",
          });
        } catch (e) {
          this.deps.logger.error(`skipping unadoptable volume build at ${path}`, e);
        }
      }
    }
    // Fail any previously-adopted downloaded ready row whose bin/postgres is no longer accessible
    // — whether the whole tag dir vanished (dir gone ⇒ postgres necessarily gone) or just the
    // binary was removed while the dir + build.json survived. A direct access() probe subsumes
    // both cases, so there's no separate "did we see the dir on this scan" bookkeeping to keep.
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.source !== "downloaded" || row.status !== "ready") continue;
      try {
        await access(join(row.path, "bin", "postgres"));
      } catch {
        this.deps.state.pgBuilds.setStatus(row.id, "failed", "build binary missing at boot");
      }
    }
  }

  // FIX-5 (final whole-branch review) — boot-only, called right after sweepTmp in index.ts: fail
  // every row still in an in-flight status (downloading/validating). No pull survives a daemon
  // restart (the pipeline is in-process and fire-and-forget), so at boot any such row is
  // definitionally orphaned by a crash mid-pull. Left alone it would be stuck forever AND
  // un-removable — assertRemovable 409s in-flight rows — forcing a state.db wipe. Failing it
  // makes it terminal + deletable; its path (if any) is kept so a DELETE can reclaim the dir
  // (remove()'s shared-path sibling check protects a same-digest retry's dir). Returns the count.
  failInterrupted(): number {
    let count = 0;
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.status !== "downloading" && row.status !== "validating") continue;
      this.deps.state.pgBuilds.setStatus(row.id, "failed", "interrupted by restart");
      count += 1;
    }
    return count;
  }

  // rm -rf every pgBuildsDir/v*/.tmp-* (interrupted-install leftovers). Returns the count removed.
  async sweepTmp(): Promise<number> {
    const majors = await readdir(this.deps.pgBuildsDir).catch(() => [] as string[]);
    let count = 0;
    for (const vdir of majors) {
      if (!/^v\d+$/.test(vdir)) continue;
      const entries = await readdir(join(this.deps.pgBuildsDir, vdir)).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.startsWith(".tmp-")) continue;
        await rm(join(this.deps.pgBuildsDir, vdir, entry), { recursive: true, force: true });
        count += 1;
      }
    }
    return count;
  }

  // Per major: pick the newest valid minor regardless of source (tie → baked), set it exclusively
  // active, and flag (never silently downgrade) if the winner falls below the recorded high-water
  // last-run minor. Candidates are ready rows with a known minor — baked rows are always trusted
  // (their minor came from a real --version probe at seed time).
  resolveActives(): { degraded: number[] } {
    this.degraded.clear();
    const byMajor = new Map<number, PgBuildRow[]>();
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.status !== "ready" || row.minor === null) continue;
      const bucket = byMajor.get(row.major);
      if (bucket) bucket.push(row);
      else byMajor.set(row.major, [row]);
    }
    for (const [major, rows] of byMajor) {
      rows.sort(byActivePreference);
      const winner = rows[0]!;
      this.deps.state.pgBuilds.setActiveExclusive(winner.id);
      const lastRun = this.deps.state.pgMajors.lastRunMinor(major);
      if (lastRun !== null && winner.minor! < lastRun) this.degraded.add(major);
    }
    // A major can have rows in the registry (e.g. a downloaded build whose only copy just went
    // `failed`) without any of them being ready. byMajor above is built from ready rows only, so
    // such a major is never visited — its stale `active=1` from a PRIOR resolve would otherwise
    // survive forever, wrongly blocking assertRemovable/GC and giving pgbinFor nothing to explain.
    for (const row of this.deps.state.pgBuilds.list()) {
      if (!byMajor.has(row.major)) this.deps.state.pgBuilds.clearActive(row.major);
    }
    return { degraded: [...this.degraded].sort((a, b) => a - b) };
  }

  // Scoped, single-major variant of resolveActives(): re-pick (or clear) ONE major's active
  // pointer using the same winner rule, AND re-derive that one major's degraded flag. Unlike
  // resolveActives it touches no other major — it's a targeted recovery primitive, not boot
  // re-derivation. The post-pull-failure path (Provisioner.runPipeline's catch) uses it to
  // restore the "an active ready build exists" invariant for the single major it just broke;
  // re-deriving every major there (as the global resolveActives it replaced did) would clobber an
  // unrelated, explicitly-pinned major on a wholly unrelated pull's failure. No ready candidate ⇒
  // clear the major's active flag: a just-failed pull row keeps active=1 (setStatus doesn't touch
  // it), which would otherwise 409 assertRemovable/GC forever as "the active build" — and clear
  // the degraded flag too (no active build is a 409-on-use state, not a silently-degraded one).
  //
  // FIX-1 (final whole-branch review): this used to leave `degraded` alone entirely — when
  // recovery elected a build BELOW the major's recorded high-water minor (reachable: a failed
  // auto-activate whose recompose threw, the previous ≥high-water build removed in the same lane
  // window), the major ran degraded with no flag/banner/log until the NEXT BOOT's resolveActives.
  // This daemon runs for days; that was the one path (boot / explicit activate / recovery) that
  // neither flagged nor blocked a downgrade — replicate resolveActives' high-water check here.
  resolveActiveFor(major: number): void {
    const ready = this.deps.state.pgBuilds.listByMajor(major)
      .filter((r) => r.status === "ready" && r.minor !== null);
    if (ready.length === 0) {
      this.deps.state.pgBuilds.clearActive(major);
      this.degraded.delete(major);
      return;
    }
    ready.sort(byActivePreference);
    this.deps.state.pgBuilds.setActiveExclusive(ready[0]!.id);
    const lastRun = this.deps.state.pgMajors.lastRunMinor(major);
    if (lastRun !== null && ready[0]!.minor! < lastRun) this.degraded.add(major);
    else this.degraded.delete(major);
  }

  // The currently-active ready build for a major, or a 409 telling the caller how to fix it —
  // T8's endpoint start resolves --pgbin through this.
  pgbinFor(major: number): { path: string; version: string; buildId: string } {
    const row = this.deps.state.pgBuilds.list()
      .find((r) => r.major === major && r.active && r.status === "ready");
    if (!row) {
      throw new DevdbError(409,
        `no usable Postgres ${major} build — pull one via POST /api/pg-builds/pull or pick an installed major`);
    }
    return { path: join(row.path, "bin", "postgres"), version: versionString(row), buildId: row.id };
  }

  // Reverse lookup: which registry row (by version string) backs a given pgbin path.
  versionForPgbin(pgbinPath: string): string | null {
    const row = this.deps.state.pgBuilds.list()
      .find((r) => pgbinPath === join(r.path, "bin", "postgres"));
    return row ? versionString(row) : null;
  }

  installedMajors(): number[] {
    const majors = new Set<number>();
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.status === "ready") majors.add(row.major);
    }
    return [...majors].sort((a, b) => a - b);
  }

  // Explicit activation (e.g. a user picking an older build from the UI). Must target a ready
  // row. A downgrade below the recorded last-run minor requires opts.consented — and consenting
  // deliberately LOWERS the high-water mark (setLastRunMinor, not recordRun) and clears the
  // degraded flag: the operator just told us the lower version is the intended baseline now.
  // Conversely, activating a build at or above the high-water mark clears any pre-existing
  // degraded flag immediately — re-pulling a build must un-degrade the major WITHOUT a reboot
  // (resolveActives only re-evaluates degradation at boot).
  activate(id: string, opts?: { consented?: boolean }): PgBuildRow {
    const row = this.deps.state.pgBuilds.byId(id);
    // Fix round 1 (review of Task 10 commit 3bfc859, Fix #3, P4): a missing row is a distinct
    // 404 "no such build", not folded into the 409 "not ready to activate" below — that 409 is
    // reserved for a row that DOES exist but isn't in a ready state (still downloading/validating/
    // failed). Contract: unknown :id → 404 everywhere in this REST surface.
    if (!row) throw new DevdbError(404, `no such build: ${id}`);
    if (row.status !== "ready") {
      throw new DevdbError(409, `pg_build ${id} is not ready to activate`);
    }
    const lastRun = this.deps.state.pgMajors.lastRunMinor(row.major);
    const isDowngrade = row.minor !== null && lastRun !== null && row.minor < lastRun;
    if (isDowngrade) {
      if (!opts?.consented) {
        throw new DevdbError(409,
          `activating ${versionString(row)} would downgrade below the last-run ${row.major}.${lastRun} — pass consented:true (see docs on extension-catalog downgrades)`);
      }
      this.deps.state.pgMajors.setLastRunMinor(row.major, row.minor!);
      this.degraded.delete(row.major);
    } else if (row.minor !== null) {
      this.degraded.delete(row.major);
    }
    this.deps.state.pgBuilds.setActiveExclusive(id);
    return this.deps.state.pgBuilds.byId(id)!;
  }

  recordRun(major: number, minor: number): void {
    this.deps.state.pgMajors.recordRun(major, minor);
  }

  degradedMajors(): number[] {
    return [...this.degraded].sort((a, b) => a - b);
  }

  list(): PgBuildRow[] {
    return this.deps.state.pgBuilds.list();
  }

  // 409s a removal request for: the active row (would strand the major mid-use), any baked row
  // (not ours to delete — it ships with the image), a row whose pull is still in flight
  // (remove() must not race a live extraction/validation), or a row whose path is a prefix of a
  // pgbin some running compute currently has open (deleting out from under a live process).
  assertRemovable(id: string, runningPgbins: string[]): PgBuildRow {
    const row = this.deps.state.pgBuilds.byId(id);
    // Fix round 1 (review of Task 10 commit 3bfc859, Fix #3, P4): a missing row is a 404, distinct
    // from every removability-CONFLICT case below (active/baked/in-flight/in-use), which all stay
    // 409 — those are real rows that exist but can't be removed right now, not "doesn't exist".
    if (!row) throw new DevdbError(404, `no such build: ${id}`);
    if (row.active) throw new DevdbError(409, `pg_build ${id} is the active build for major ${row.major}`);
    if (row.source === "baked") throw new DevdbError(409, `pg_build ${id} is a baked build and cannot be removed`);
    if (row.status === "downloading" || row.status === "validating") {
      throw new DevdbError(409, `pg_build ${id} has a pull in flight — wait for it to finish or fail`);
    }
    // FIX-4 (final whole-branch review): rows that failed before setDigestPath (and, post FIX-3,
    // every failure-rm'd row) carry path === "" — the prefix test would degenerate to
    // startsWith("/"), matching EVERY running pgbin and 409ing the cleanup of any early-failed
    // row whenever anything at all was running. An empty-path row owns no directory: never in use.
    // (services/dto.ts's inUse mapper applies the identical rule — keep them in agreement.)
    if (row.path !== "" && runningPgbins.some((p) => p.startsWith(row.path + "/"))) {
      throw new DevdbError(409, `pg_build ${id} is in use by a running endpoint`);
    }
    return row;
  }

  // GC-eligible builds: per major, ready downloaded rows other than the active one and the single
  // newest non-active one (keep active + one previous as a fast rollback target).
  gcCandidates(): PgBuildRow[] {
    const byMajor = new Map<number, PgBuildRow[]>();
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.status !== "ready" || row.source !== "downloaded" || row.active) continue;
      const bucket = byMajor.get(row.major);
      if (bucket) bucket.push(row);
      else byMajor.set(row.major, [row]);
    }
    const candidates: PgBuildRow[] = [];
    for (const rows of byMajor.values()) {
      rows.sort((a, b) => (b.minor ?? -Infinity) - (a.minor ?? -Infinity));
      candidates.push(...rows.slice(1));
    }
    return candidates;
  }
}
