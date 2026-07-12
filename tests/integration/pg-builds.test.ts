import { execa } from "execa";
import { Network, type StartedNetwork } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import {
  injectLastRunMinor, seedComputeImageFromDevdb, seedStubImage, startFixtureRegistry, type FixtureRegistry,
} from "./helpers/fixture-registry.js";
import { api, connect } from "./helpers/pg.js";

// Task 15 (dynamic-pg-builds): the hermetic end-to-end suite. A REAL Neon-built PG tree (the
// image's own baked v17, re-published through an in-network fixture registry — never Docker Hub)
// is pulled by the REAL daemon, extracted through the full symlink-policy path, and validated by
// the REAL gate against LIVE storage. The three tests are deliberately ORDER-DEPENDENT (each
// builds on the previous one's state), matching the brief: pull→gate→active→usable, then a
// gate-failure that must not disturb that state, then re-up survival + the downgrade guard.
//
// Same-minor dedup (provisioner.extractFixupAndGate, commit 05323e4): a pull whose detected minor
// already exists as a ready build is a no-op. The baked v17 is 17.5, so the downloaded and stub
// fixtures each report a DISTINCT non-baked minor via a `bin/postgres` version shim (real image)
// or the stub's fake banner — otherwise the pulls would dedup before reaching the gate/activate
// path each test exercises. The shim still `exec`s the genuine 17.x server, so the gate and the
// project endpoint serve real SQL; only the daemon's version LABEL is forged.

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
  // Derived from the daemon's own baked row, not hardcoded (so this survives a pin move): the baked
  // v17 minor anchors the fixture minors below. The DOWNLOADED fixture reports one minor BELOW baked
  // and the STUB two below — both non-baked (so neither dedups) and both below baked, which keeps
  // test 3's "baked wins at re-up" + downgrade assertions true (a minor ABOVE baked would flip them).
  let bakedVersion: string;
  let bakedMinor: number;
  let dlVersion: string; // the downloaded fixture's forged version string, e.g. "17.4" (bakedMinor − 1)
  let dlMinor: number; // its minor, e.g. 4 — test 3's marker-forge sed targets this in build.json
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
    // Two distinct non-baked minors, both below baked (see the derive-comment above). Needs baked
    // minor ≥ 2 so the stub minor stays ≥ 0 — fail loudly rather than seed a nonsense version if a
    // future pin lands baked absurdly low.
    if (bakedMinor < 2) throw new Error(`baked v17 minor ${bakedMinor} too low for the fixture minor scheme`);
    dlMinor = bakedMinor - 1;
    dlVersion = `17.${dlMinor}`;
    const stubMinor = bakedMinor - 2;

    // The downloaded fixture carries a version shim so its `postgres --version` reports 17.<dlMinor>
    // (≠ baked) — the pull reaches the gate/activate path instead of dedup-no-op'ing — while the
    // shim still execs the real 17.5 server for the gate + endpoint.
    seededDigest = (await seedComputeImageFromDevdb({
      devdb: dev, externalBase: registry.externalBase, repository: REPO, tag: REAL_TAG,
      reportVersion: dlVersion,
    })).manifestDigest;
    // The stub reports a THIRD minor (17.<stubMinor>) — distinct from baked AND from the downloaded
    // 17.<dlMinor> — so it dedups against neither and actually reaches the gate it must fail.
    await seedStubImage({
      externalBase: registry.externalBase, repository: REPO, tag: STUB_TAG, version: `17.${stubMinor}`,
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
    expect(row.version).toBe(dlVersion); // the shim forged a non-baked minor; the daemon detected it
    expect(row.imageDigest.startsWith("sha256:")).toBe(true);
    expect(row.imageDigest).toBe(seededDigest); // daemon's resolveDigest computed OUR content-address
    expect(row.source).toBe("downloaded");
    expect(row.releaseTag).toBe(REAL_TAG);

    const m = await major17();
    expect(m.source).toBe("downloaded"); // auto-activate flipped the major to the pulled build
    expect(m.activeVersion).toBe(dlVersion);

    // A PG-17 project's endpoint must now start FROM the downloaded build (pgbinFor resolves the
    // active row fresh per start) and serve real SQL against live storage.
    const created = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "pgbe2e", pgVersion: 17 });
    mainId = created.mainBranch.id;
    const branch = await api<{ connectionString: string | null; runningPgVersion: string | null }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    expect(branch.runningPgVersion).toBe(dlVersion); // resolved from the downloaded ROW (17.<dlMinor>), not baked 17.5
    // The forged minor already distinguishes the downloaded build from baked; inUse on the
    // downloaded ROW additionally proves the compute actually runs from ITS pgbin (the shim-wrapped
    // tree), not the baked one.
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
    expect(m.activeVersion).toBe(dlVersion); // still test 1's downloaded 17.<dlMinor> — the stub's gate failure left it untouched

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

  it("volume build survives re-up; a forged marker is rejected (FIX-6); an injected high-water flags the downgrade", async () => {
    if (!mainId) throw new Error("test 3 depends on test 1's project (suite is order-dependent)");

    // --- Re-up survival: rows/markers re-adopted at boot.
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    const dl = (await listBuilds()).find((r) => r.imageDigest === seededDigest);
    expect(dl?.status).toBe("ready");
    // Downloaded is 17.<dlMinor>, baked is 17.5 — so at boot resolveActives elects baked as the
    // NEWEST minor, NOT the downloaded pointer test 1 left active: "source stays downloaded" is not
    // the post-restart contract. The survivable facts are: the downloaded row still exists ready (a
    // rollback target), and the major serves baked 17.5 — above the 17.<dlMinor> high-water, so not
    // degraded.
    let m = await major17();
    expect(m.activeVersion).toBe(bakedVersion);
    expect(m.degradedDowngrade).toBe(false);

    // --- FIX-6: adoptVolumeBuilds now validates a marker against its on-disk location (dir basename
    // == shortDigest(digest), major == vN) and adopts the DETECTED binary version. Forging a high
    // minor by mv-ing the dir to a non-content-address name and sed-ing build.json to minor:99 is
    // exactly what it must REJECT: the dir `fake99-${short}` != shortDigest, and the shim's binary
    // still detects 17.<dlMinor> regardless. The mv un-claims the original dir, so its persisted row
    // is failed by the missing-binary sweep — major 17 falls back to baked 17.5 and the forged
    // 17.99 never surfaces. (The sed targets dlMinor — the minor the pull wrote into build.json.)
    const short = seededDigest.replace(/^sha256:/, "").slice(0, 16);
    const dir = `/data/pg_builds/v17/${short}`;
    const dir99 = `/data/pg_builds/v17/fake99-${short}`;
    await execa("docker", ["exec", dev.container.getId(), "sh", "-c",
      // Guard the forge against a silent no-op: sed exits 0 on no-match, so if build.json's
      // marker format ever drifts from the compact `"minor":N,` this rewrites, the forge would
      // quietly do nothing while the test still "passed". The trailing comma keeps grep exact
      // (minor is always followed by ,"extractedAt") so it asserts minor:99 actually landed.
      `mv ${dir} ${dir99} && sed -i 's/"minor":${dlMinor}/"minor":99/' ${dir99}/build.json && grep -q '"minor":99,' ${dir99}/build.json`]);
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    expect((await listBuilds()).some((r) => r.status === "ready" && r.version === "17.99")).toBe(false); // forged 17.99 rejected
    m = await major17();
    expect(m.activeVersion).toBe(bakedVersion); // fell back to baked 17.5
    expect(m.source).toBe("baked");
    expect(m.degradedDowngrade).toBe(false); // baked 17.5 is ABOVE the 17.<dlMinor> high-water from test 1 — not a downgrade

    // --- Downgrade guard via a LEGIT high-water injection (the forged-build path can no longer set
    // one). injectLastRunMinor writes the high-water straight into the daemon's SQLite, dispatching on
    // the suite's env prefix (node+better-sqlite3 into pg_majors for the default image; the in-image
    // sqlite3 CLI into pg_actives for the Go image). busy_timeout covers the daemon's WAL writer; the
    // restart re-reads it at boot.
    await injectLastRunMinor(dev, 17, 99);
    // Remove the rejected forged dir so only baked 17.5 remains resolvable, then re-derive at boot:
    // baked 17.5 sits BELOW the injected high-water 99, so the never-silent-downgrade guard must flag
    // it (spec decision 10) while still serving the baked fallback.
    await execa("docker", ["exec", dev.container.getId(), "rm", "-rf", dir99]);
    await dev.restart({ timeout: 60_000 });
    await waitHealthy();
    m = await major17();
    expect(m.degradedDowngrade).toBe(true);
    expect(m.activeVersion).toBe(bakedVersion);
    expect(m.source).toBe("baked");
  }, 540_000);
});
