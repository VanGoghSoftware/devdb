import { execa } from "execa";
import { Network, type StartedNetwork } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import {
  seedComputeImageFromDevdb, seedStubImage, startFixtureRegistry, type FixtureRegistry,
} from "./helpers/fixture-registry.js";
import { api, connect } from "./helpers/pg.js";

// Task 15 (dynamic-pg-builds): the hermetic end-to-end suite. A REAL Neon-built PG tree (the
// image's own baked v17, re-published through an in-network fixture registry — never Docker Hub)
// is pulled by the REAL daemon, extracted through the full symlink-policy path, and validated by
// the REAL gate against LIVE storage. The three tests are deliberately ORDER-DEPENDENT (each
// builds on the previous one's state), matching the brief: pull→gate→active→usable, then a
// gate-failure that must not disturb that state, then re-up survival + the downgrade guard.

const REPO = "neondatabase/compute-node-v17"; // repoFor(17) under the daemon's DEFAULT image template
const REAL_TAG = "9999";
const STUB_TAG = "stub";

interface BuildRow {
  id: string; major: number; minor: number | null; version: string | null;
  source: "baked" | "downloaded"; releaseTag: string; imageDigest: string;
  status: "downloading" | "validating" | "ready" | "failed";
  active: boolean; inUse: boolean; sizeBytes: number | null; error: string | null;
  createdAt: string;
}
interface MajorStatus {
  activeVersion: string | null; source: "baked" | "downloaded" | null;
  degradedDowngrade: boolean; updateAvailable: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("dynamic pg builds (hermetic e2e)", () => {
  let net: StartedNetwork;
  let dev: Devdb;
  let registry: FixtureRegistry;
  // Derived from the daemon's own baked row, not hardcoded: the fixture layer IS the baked build
  // ("17.5" with the currently-pinned neond image), so deriving keeps every equality below — and
  // the tie-goes-to-baked assertions in test 3 — true by construction even if the pin moves.
  let bakedVersion: string;
  let bakedMinor: number;
  let seededDigest: string; // manifest digest of the REAL fixture image (tag 9999)
  let mainId: string; // test 1's project main branch; test 3 reuses it for the high-water run

  const listBuilds = (): Promise<BuildRow[]> => api<BuildRow[]>(dev, "GET", "/api/pg-builds");

  const major17 = async (): Promise<MajorStatus> => {
    const s = await api<{ pgBuilds: Record<string, MajorStatus> }>(dev, "GET", "/api/status");
    const m = s.pgBuilds["17"];
    if (!m) throw new Error(`GET /api/status has no pgBuilds["17"]: ${JSON.stringify(s.pgBuilds)}`);
    return m;
  };

  // Raw fetch (not api()) so non-2xx statuses are ASSERTABLE — test 2 must distinguish an
  // accepted retry (202) from a wrongly-latched pull mutex (409).
  const pullTag = async (tag: string): Promise<{ status: number; buildId?: string; body: string }> => {
    const res = await fetch(`${dev.base}/api/pg-builds/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ major: 17, tag }),
    });
    const body = await res.text();
    return {
      status: res.status,
      buildId: res.status === 202 ? (JSON.parse(body) as { buildId: string }).buildId : undefined,
      body,
    };
  };

  const pollBuild = async (
    buildId: string, target: "ready" | "failed", timeoutMs = 240_000,
  ): Promise<BuildRow> => {
    const deadline = Date.now() + timeoutMs;
    let last: BuildRow | undefined;
    for (;;) {
      last = (await listBuilds()).find((r) => r.id === buildId);
      if (last?.status === target) return last;
      if (last && (last.status === "ready" || last.status === "failed")) {
        // Terminal, but the WRONG terminal — fail fast and loud with the row's recorded error.
        throw new Error(
          `build ${buildId} reached terminal "${last.status}" (wanted "${target}") — row.error: ${last.error ?? "<none>"}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out (${timeoutMs}ms) waiting for build ${buildId} to reach "${target}" — last row: ${JSON.stringify(last)}`);
      }
      await sleep(3_000);
    }
  };

  // restart() resolving guarantees /api/status answers 200 again (the wait strategy re-runs),
  // but that route returns 200 with healthy:false while engine processes are still coming up.
  const waitHealthy = async (): Promise<void> => {
    for (let i = 0; i < 120; i++) {
      try {
        const s = await fetch(`${dev.base}/api/status`);
        if (s.ok && ((await s.json()) as { healthy: boolean }).healthy) return;
      } catch { /* container coming back */ }
      await sleep(2_000);
    }
    throw new Error("daemon did not report healthy after restart");
  };

  beforeAll(async () => {
    net = await new Network().start();
    // The daemon boots BEFORE the fixture registry even exists: DEVDB_PG_REGISTRY_BASE is only
    // dialed by check/pull, never at boot — the daemon coming up healthy here is itself proof of
    // the registry→compose-pg_distrib→engine boot order (a broken order can't serve /api/status).
    dev = await startDevdb({ DEVDB_PG_REGISTRY_BASE: "http://pgregistry:5000" }, { network: net });
    registry = await startFixtureRegistry(net);

    const baked = (await listBuilds()).find((r) => r.source === "baked" && r.major === 17);
    if (!baked?.version || baked.minor === null) {
      throw new Error(`no baked v17 registry row at boot: ${JSON.stringify(baked)}`);
    }
    bakedVersion = baked.version;
    bakedMinor = baked.minor;

    seededDigest = (await seedComputeImageFromDevdb({
      devdb: dev, externalBase: registry.externalBase, repository: REPO, tag: REAL_TAG,
    })).manifestDigest;
    await seedStubImage({
      externalBase: registry.externalBase, repository: REPO, tag: STUB_TAG, version: bakedVersion,
    });
  });

  afterAll(async () => {
    await dev?.stop();
    await registry?.stop();
    await net?.stop();
  });

  it("pull → validate against LIVE storage → ready + auto-active; a project on it serves SQL", async () => {
    const pulled = await pullTag(REAL_TAG);
    expect(pulled.status, pulled.body).toBe(202);
    const buildId = pulled.buildId;
    if (!buildId) throw new Error(`202 without buildId: ${pulled.body}`);

    // Task-6 empirical answer lives HERE: this poll spans download → extract (the symlink-policy
    // path, over a real Neon PG tree with relative in-tree symlinks) → fixup → the REAL
    // validation gate (live compute against the running pageserver/safekeeper). A "failed" row
    // with an extraction/"unsafe … entry"/symlink error is the deferred Task-6 over-rejection
    // biting on a real image — a REAL finding to report loudly, not a test bug to paper over.
    const row = await pollBuild(buildId, "ready");
    expect(row.active).toBe(true);
    expect(row.version).toBe(bakedVersion); // the fixture layer IS the baked build — versions must agree
    expect(row.imageDigest.startsWith("sha256:")).toBe(true);
    expect(row.imageDigest).toBe(seededDigest); // daemon's resolveDigest computed OUR content-address
    expect(row.source).toBe("downloaded");
    expect(row.releaseTag).toBe(REAL_TAG);

    const m = await major17();
    expect(m.source).toBe("downloaded"); // auto-activate flipped the major to the pulled build
    expect(m.activeVersion).toBe(bakedVersion);

    // A PG-17 project's endpoint must now start FROM the downloaded build (pgbinFor resolves the
    // active row fresh per start) and serve real SQL against live storage.
    const created = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "pgbe2e", pgVersion: 17 });
    mainId = created.mainBranch.id;
    const branch = await api<{ connectionString: string | null; runningPgVersion: string | null }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    expect(branch.runningPgVersion).toBe(bakedVersion);
    // Baked and downloaded share the version STRING — inUse on the downloaded ROW is what proves
    // the compute actually runs from the downloaded build's pgbin, not the baked one.
    expect((await listBuilds()).find((r) => r.id === buildId)?.inUse).toBe(true);
    if (!branch.connectionString) throw new Error("endpoint started without a connectionString");

    const client = await connect(dev, branch.connectionString);
    try {
      expect((await client.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  }, 420_000);

  it("stub build fails the gate cleanly: row failed, active pointer untouched, retry allowed", async () => {
    const first = await pullTag(STUB_TAG);
    expect(first.status, first.body).toBe(202);
    if (!first.buildId) throw new Error(`202 without buildId: ${first.body}`);
    // The stub passes fixup's version detection (its fake --version banner) but cannot serve a
    // compute, so the gate MUST kill it. If this poll returns "ready" the gate validated nothing.
    const failedRow = await pollBuild(first.buildId, "failed");
    expect(failedRow.error).toBeTruthy(); // the gate's reason must land on the row
    expect(failedRow.active).toBe(false);

    // The previously-active build (test 1's 9999 pull — order matters, this runs AFTER; isolated
    // it would be the baked row) is untouched by the failure:
    const active = (await listBuilds()).find((r) => r.major === 17 && r.active);
    expect(active?.imageDigest).toBe(seededDigest);
    expect(active?.status).toBe("ready");
    const m = await major17();
    expect(m.source).toBe("downloaded");
    expect(m.activeVersion).toBe(bakedVersion);

    // A FAILED attempt must not latch the pull mutex — 409 is for in-flight pulls only. (The row
    // flips "failed" a beat before the pipeline's finally releases the mutex; the pause keeps
    // this asserting the contract, not that microtask gap.)
    await sleep(2_000);
    const second = await pullTag(STUB_TAG);
    expect(second.status, second.body).toBe(202);
    expect(second.buildId).not.toBe(first.buildId);
    if (!second.buildId) throw new Error(`202 without buildId: ${second.body}`);
    // Run the retry to ITS terminal state too, so test 3's restarts never interrupt a live pull
    // (a mid-flight row would be stranded "downloading" across the re-up).
    const secondRow = await pollBuild(second.buildId, "failed");
    expect(secondRow.error).toBeTruthy();
  }, 420_000);

  it("volume build survives re-up; fake-17.99 marker adopts + records high-water; deleting it flags the downgrade", async () => {
    if (!mainId) throw new Error("test 3 depends on test 1's project (suite is order-dependent)");

    // --- Re-up survival: rows/markers re-adopted at boot.
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    const dl = (await listBuilds()).find((r) => r.imageDigest === seededDigest);
    expect(dl?.status).toBe("ready");
    // Baked and downloaded are BOTH 17.5 here, and the boot tie deliberately goes to baked
    // (resolveActives) — so "source stays downloaded" is NOT the post-restart contract. The
    // survivable facts are: the downloaded row still exists ready, and the major serves 17.5.
    let m = await major17();
    expect(m.activeVersion).toBe(bakedVersion);
    expect(m.degradedDowngrade).toBe(false);

    // --- Fake a 17.99 via the marker. The brief's plain `sed` on build.json is not sufficient
    // on its own: the pull-created row (persisted in /data's SQLite across the re-up) still
    // CLAIMS the dir path, and adoptVolumeBuilds re-reads markers only for UNCLAIMED dirs. The
    // `mv` un-claims it — the stale row gets failed by the missing-binary sweep, and the sed'd
    // marker is re-adopted as a fresh dl- row. Marker-adoption trusting the marker (id and minor
    // both come from build.json, never from the dir name) is exactly the surface under test.
    const short = seededDigest.replace(/^sha256:/, "").slice(0, 16);
    const dir = `/data/pg_builds/v17/${short}`;
    const dir99 = `/data/pg_builds/v17/fake99-${short}`;
    await execa("docker", ["exec", dev.container.getId(), "sh", "-c",
      `mv ${dir} ${dir99} && sed -i 's/"minor":${bakedMinor}/"minor":99/' ${dir99}/build.json`]);
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    m = await major17();
    expect(m.activeVersion).toBe("17.99");
    expect(m.source).toBe("downloaded");
    expect(m.degradedDowngrade).toBe(false); // 99 sits ABOVE the recorded high-water — nothing degraded yet

    // recordRun: a real (non-gate) endpoint start on the active fake-17.99 build raises the
    // major's high-water to 99 — the same binary bits as 17.5, so the compute genuinely serves.
    const branch = await api<{ runningPgVersion: string | null }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    expect(branch.runningPgVersion).toBe("17.99");
    await api(dev, "POST", `/api/branches/${mainId}/endpoint/stop`);

    // --- Delete the 17.99 build out from under the registry → next boot resolves baked 17.5,
    // BELOW the 17.99 high-water: the never-silent-downgrade guard must flag it (spec decision
    // 10) while still serving the baked fallback.
    await execa("docker", ["exec", dev.container.getId(), "rm", "-rf", dir99]);
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    m = await major17();
    expect(m.degradedDowngrade).toBe(true);
    expect(m.activeVersion).toBe(bakedVersion);
    expect(m.source).toBe("baked");
  }, 540_000);
});
