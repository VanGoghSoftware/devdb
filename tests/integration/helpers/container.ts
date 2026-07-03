import { execa } from "execa";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

const IMAGE = "devdb:dev";
let built = false;

export async function buildImage(): Promise<void> {
  if (built) return;
  await execa("docker", ["build", "-f", "docker/Dockerfile", "-t", IMAGE, "."], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: "inherit",
  });
  built = true;
}

// T16 finding, reproduced in isolation against this exact image (11 exposed ports: 4400 +
// 54300-54309, matching the withExposedPorts() call below): testcontainers@10.28.0 calls
// docker inspect() and rebuilds its internal port-binding cache (BoundPorts) IMMEDIATELY after
// issuing a container start/restart, before Docker has finished re-publishing every exposed
// port's NAT rule — an independent `docker inspect` run moments later always showed complete,
// correct bindings for all 11 ports (proof the underlying container-level start/restart itself
// is not the problem; this is a read-too-early race in testcontainers' own bookkeeping). It
// throws "No host port found for host IP" from bound-ports.js's resolveHostPortBinding, and has
// been observed from BOTH GenericContainer.start() (generic-container.js's startContainer(),
// called via startDevdb() below) and StartedGenericContainer.restart() (Devdb.restart() below)
// — same race, two different call sites in the same library version. On the restart() path,
// critically, the throw happens BEFORE the internal boundPorts cache is updated, leaving
// container.getMappedPort() PERMANENTLY stale (frozen at the pre-restart port) even though the
// container is actually healthy again within about a second; a bare retry of restart() does not
// reliably route around this either (reproduced 3 consecutive throws on a second restart round
// in the same process). Two mitigations follow: retryStart() below retries the ENTIRE
// GenericContainer(...).start() chain (a fresh, uniquely-named container each attempt — best-
// effort stopped immediately on a caught failure rather than left for testcontainers' own
// reaper/Ryuk to eventually clean up at session end, see retryStart()'s own doc comment for why
// and how), and Devdb.restart() treats the specific throw as informational rather than fatal,
// confirming the container is actually back via a live `docker port` + /api/status poll and
// refreshing THIS Devdb instance's own `ports` map (never testcontainers' internal one, which the
// restart failure path leaves stale).
async function livePort(containerId: string, containerPort: number): Promise<number> {
  const { stdout } = await execa("docker", ["port", containerId, `${containerPort}/tcp`]);
  // Typical output: "0.0.0.0:55599\n[::]:55599" — take the first line's port number.
  const first = stdout.split("\n")[0];
  const match = first?.match(/:(\d+)$/);
  if (!match) throw new Error(`could not parse "docker port ${containerId} ${containerPort}/tcp" output: ${stdout}`);
  return Number(match[1]);
}

function isPortRace(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("No host port found for host IP");
}

// Fix 5 (review): traced through generic-container.js's startContainer() (testcontainers@10.28.0)
// to confirm exactly where this throw lands — client.container.create() and client.container.
// start() (the actual `docker create`+`docker start`) both run and SUCCEED before
// BoundPorts.fromInspectResult() throws "No host port found for host IP"; the throw is purely in
// testcontainers' own post-start port-binding bookkeeping. That means every failed attempt here
// leaves a REAL, running Docker container behind — GenericContainer's `.start()` promise rejects
// with no return value, so its container id is never exposed to this function; the only prior
// safety net was testcontainers' own Ryuk reaper, which cleans up labeled containers but only at
// session end (or on an explicit signal), not immediately. With 3 retry attempts possible per
// startDevdb() call and this helper used by 6+ integration test files, a flaky CI run could
// accumulate several live (if useless) `devdb:dev` containers for the lifetime of the whole test
// run before Ryuk ever reaps them.
//
// Fix: assign each attempt a predictable name via .withName() BEFORE calling build() — a
// reference to "the failed attempt" testcontainers itself never had to hand back — so that on a
// caught port-race throw, this function can `docker stop` that exact container immediately
// instead of waiting on Ryuk. Best-effort and guarded: `docker stop` on a container that doesn't
// exist (the throw happened before `docker create` for some OTHER reason we don't fully
// understand) or is already gone must never mask the real port-race error being retried around.
async function retryStart(
  build: (attemptName: string) => Promise<StartedTestContainer>, attempts = 3,
): Promise<StartedTestContainer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const attemptName = `devdb-integration-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      return await build(attemptName);
    } catch (e) {
      if (!isPortRace(e)) throw e;
      lastErr = e;
      // Best-effort: stop the container this failed attempt actually created and started in
      // Docker (confirmed live above the throw) so it isn't left running until Ryuk eventually
      // reaps it. Never let a failure HERE (container already gone, name mismatch, docker CLI
      // hiccup) mask or replace the port-race error this loop is retrying around — swallow and
      // move on to the retry regardless.
      try {
        await execa("docker", ["stop", attemptName]);
      } catch (stopErr) {
        console.error(`retryStart: best-effort stop of failed attempt "${attemptName}" also failed (non-fatal, continuing retry):`, stopErr);
      }
      // A short pause before retrying the whole start() chain — the race is a timing window,
      // not a persistent condition, so giving Docker a moment before the next attempt (which
      // creates and starts an entirely new container) is cheap insurance against re-hitting it
      // immediately.
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

export interface Devdb {
  base: string;
  container: StartedTestContainer;
  mappedPort(containerPort: number): number;
  /**
   * Restarts the container. Resilient to the testcontainers restart() port-cache race
   * documented above: on success (or on the specific benign throw, confirmed recovered), this
   * daemon's own tracked ports refresh via a live `docker port` query for every exposed port —
   * so `dev.base` / `dev.mappedPort()` stay correct for the rest of the test, unlike relying on
   * testcontainers' own (potentially permanently stale, post-restart) getMappedPort() cache.
   */
  restart(options?: { timeout: number }): Promise<void>;
  stop(): Promise<void>;
}

export async function startDevdb(env: Record<string, string> = {}): Promise<Devdb> {
  await buildImage();
  const endpointPorts = Array.from({ length: 10 }, (_, i) => 54300 + i);
  const exposedPorts = [4400, ...endpointPorts];
  const container = await retryStart((attemptName) =>
    new GenericContainer(IMAGE)
      .withName(attemptName)
      .withEnvironment({ DEVDB_PORT_RANGE: "54300-54309", ...env })
      .withExposedPorts(...exposedPorts)
      .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
      .withStartupTimeout(240_000)
      .start());

  // Owned by this Devdb instance, not testcontainers — refreshed on every successful start()
  // (here) and restart() (below), so base/mappedPort never depend on testcontainers' own
  // internal cache staying in sync across a restart.
  const ports = new Map<number, number>(exposedPorts.map((p) => [p, container.getMappedPort(p)]));

  return {
    get base() {
      return `http://localhost:${ports.get(4400)}`;
    },
    container,
    mappedPort: (p) => {
      const mapped = ports.get(p);
      if (mapped === undefined) throw new Error(`port ${p} was not exposed by startDevdb() — add it to exposedPorts`);
      return mapped;
    },
    async restart(options) {
      let raced: unknown;
      try {
        await container.restart(options);
        for (const p of exposedPorts) ports.set(p, container.getMappedPort(p));
        return;
      } catch (e) {
        if (!isPortRace(e)) throw e;
        raced = e; // hoisted so the confirmation-failure branch below can rethrow the ORIGINAL error
      }
      // Landed in the documented race: confirm the container is actually back (bypassing
      // testcontainers' now-permanently-stale cache) via our OWN live port + /api/status poll.
      const id = container.getId();
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        try {
          const port4400 = await livePort(id, 4400);
          const res = await fetch(`http://localhost:${port4400}/api/status`);
          if (res.ok) { confirmed = true; break; }
        } catch { /* container/port still settling */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!confirmed) throw raced; // genuinely didn't come back — surface the original error, not a swallowed timeout
      for (const p of exposedPorts) ports.set(p, await livePort(id, p));
    },
    stop: async () => { await container.stop({ timeout: 30_000 }); },
  };
}
