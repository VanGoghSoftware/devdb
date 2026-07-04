import { readdir, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DevdbError } from "../../services/errors.js";
import type { StateDb } from "../../state/db.js";
import type { PgBuildRow } from "../../state/repos.js";

interface BuildMarker { digest: string; tag: string; major: number; minor: number; extractedAt: string }

function versionString(row: PgBuildRow): string {
  return `${row.major}.${row.minor}`;
}

export class BuildRegistry {
  private degraded = new Set<number>();

  constructor(private deps: {
    state: StateDb; pgInstallDir: string; pgBuildsDir: string;
    detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>;
    logger: { info(m: string): void; error(m: string, e?: unknown): void };
  }) {}

  // Scans pgInstallDir for v<digits> dirs (skipping vanilla_* — the storcon-internal postgres,
  // not a tenant version). Detects each baked dir's version once per boot and upserts a stable
  // baked-v{major} row. Idempotent: an existing baked-v{major} id is left untouched — a baked
  // dir's minor cannot change without a new container image, so re-detecting is pointless work.
  async seedBaked(): Promise<void> {
    const entries = await readdir(this.deps.pgInstallDir).catch(() => [] as string[]);
    for (const name of entries) {
      const m = /^v(\d+)$/.exec(name);
      if (!m) continue; // also excludes vanilla_v17 etc.
      const path = join(this.deps.pgInstallDir, name);
      const id = `baked-${name}`;
      if (this.deps.state.pgBuilds.byId(id)) continue;
      const { major, minor } = await this.deps.detectVersion(join(path, "bin", "postgres"));
      this.deps.state.pgBuilds.insert({
        id, major, minor, source: "baked", releaseTag: "baked", imageDigest: "", path, status: "ready",
      });
    }
  }

  // Re-inserts registry rows from build.json markers under pgBuildsDir/v*/<tag>/ (skipping
  // .tmp-* — in-progress installs). Markers are self-describing so this recovers registry state
  // even from a lost SQLite. Rows whose backing dir has vanished since the last adopt are marked
  // failed via a presence check on bin/postgres (not a re-hash — the atomic-rename install
  // discipline is what makes presence trustworthy).
  async adoptVolumeBuilds(): Promise<void> {
    const majors = await readdir(this.deps.pgBuildsDir).catch(() => [] as string[]);
    for (const vdir of majors) {
      if (!/^v\d+$/.test(vdir)) continue;
      const tags = await readdir(join(this.deps.pgBuildsDir, vdir)).catch(() => [] as string[]);
      for (const tag of tags) {
        if (tag.startsWith(".tmp-")) continue;
        const path = join(this.deps.pgBuildsDir, vdir, tag);
        const id = `dl-${vdir.slice(1)}-${tag}`;
        if (this.deps.state.pgBuilds.byId(id)) continue;
        try {
          const marker = JSON.parse(await readFile(join(path, "build.json"), "utf8")) as BuildMarker;
          await access(join(path, "bin", "postgres"));
          this.deps.state.pgBuilds.insert({
            id, major: marker.major, minor: marker.minor, source: "downloaded",
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
      rows.sort((a, b) =>
        (b.minor! - a.minor!) || ((a.source === "baked" ? -1 : 1) - (b.source === "baked" ? -1 : 1)));
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
    if (!row || row.status !== "ready") {
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
  // (not ours to delete — it ships with the image), or a row whose path is a prefix of a pgbin
  // some running compute currently has open (deleting out from under a live process).
  assertRemovable(id: string, runningPgbins: string[]): PgBuildRow {
    const row = this.deps.state.pgBuilds.byId(id);
    if (!row) throw new DevdbError(409, `pg_build ${id} not found`);
    if (row.active) throw new DevdbError(409, `pg_build ${id} is the active build for major ${row.major}`);
    if (row.source === "baked") throw new DevdbError(409, `pg_build ${id} is a baked build and cannot be removed`);
    if (runningPgbins.some((p) => p.startsWith(row.path + "/"))) {
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
