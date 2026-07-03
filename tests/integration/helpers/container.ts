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
// GenericContainer(...).start() chain (a fresh container each attempt — a container orphaned by
// a failed attempt is still labeled for testcontainers' own reaper/Ryuk cleanup, so it does not
// leak past this process's lifetime), and Devdb.restart() treats the specific throw as
// informational rather than fatal, confirming the container is actually back via a live
// `docker port` + /api/status poll and refreshing THIS Devdb instance's own `ports` map (never
// testcontainers' internal one, which the restart failure path leaves stale).
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

async function retryStart(build: () => Promise<StartedTestContainer>, attempts = 3): Promise<StartedTestContainer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await build();
    } catch (e) {
      if (!isPortRace(e)) throw e;
      lastErr = e;
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
  const container = await retryStart(() =>
    new GenericContainer(IMAGE)
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
