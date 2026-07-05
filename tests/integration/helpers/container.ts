import { execa } from "execa";
import { GenericContainer, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";

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

// T16 epilogue: the testcontainers@10.28.0 port-binding race this helper used to work around
// (~100 lines: retryStart() re-running the whole start() chain with per-attempt named containers,
// a livePort()/`docker port` re-derivation of every mapping, and a restart() recovery path that
// treated "No host port found for host IP" as informational) is fixed upstream —
//   - the start() path in 11.0.1 (testcontainers-node#1032),
//   - the restart() path in 11.4.0 (testcontainers-node#1087).
// Both paths now call inspectContainerUntilPortsExposed(), which polls `docker inspect` every
// 250ms (fixed 10s cap) until every port in HostConfig.PortBindings has a non-empty host-binding
// array BEFORE rebuilding the internal BoundPorts cache, eliminating the read-too-early race that
// threw "No host port found for host IP" and — on the restart() path — left getMappedPort()
// permanently stale. Since 11.4.0 restart() also re-runs the startup wait strategy (the
// Wait.forHttp below), so a resolved restart() means the API answers 200 again.
//
// Re-verified against THIS image (all 11 exposed ports) with raw GenericContainer, no mitigation,
// sequential start + restart({timeout}) cycles: on 10.28.0 the race hit 8 of 28 restarts, each
// leaving all 11 getMappedPort() values frozen at their pre-restart ports (confirmed against
// `docker port` ground truth); on 12.0.4 it hit 0 of 59 restarts and 0 of 20 starts. What DID
// surface once on 12.0.4 is the fix's own bounded failure mode: when Docker takes longer than the
// poll's fixed 10s cap to republish all 11 ports, restart() throws "Timed out after 10000ms while
// waiting for container ports to be bound to the host". That throw still leaves the port cache
// un-refreshed, but unlike the old race it is loud, specific, and cleanly recoverable: a second
// restart() re-polls from a fresh inspect and rebuilds the cache (confirmed in the same stress
// run — the very next restart of that container came back fully consistent). Devdb.restart()
// below therefore retries exactly once on that timeout signature; every other failure, including
// any resurrection of the old race message, surfaces immediately.
const BIND_TIMEOUT_SIGNATURE = "waiting for container ports to be bound";

// Tripwire, not a wait: after a successful start()/restart() on testcontainers >=11.4, every
// exposed port is guaranteed resolvable (see epilogue above). If this throws, the upstream
// port-binding fix has regressed — better to fail here naming the exact port than as an
// unrelated-looking connection error deep inside a test.
function assertAllPortsBound(container: StartedTestContainer, ports: number[]): void {
  for (const p of ports) container.getMappedPort(p);
}

export interface Devdb {
  base: string;
  container: StartedTestContainer;
  mappedPort(containerPort: number): number;
  /**
   * Restarts the container. testcontainers >=11.4 waits for all host port bindings to be
   * republished and re-runs the startup wait strategy, so on resolve /api/status answers 200
   * and getMappedPort() reflects the post-restart bindings (they change on every restart).
   * `timeout` is the docker stop grace period in MILLISECONDS (was seconds before
   * testcontainers 11). Retries once if Docker exceeds the library's fixed 10s port-republish
   * poll — see the T16 epilogue above.
   */
  restart(options?: { timeout: number }): Promise<void>;
  stop(): Promise<void>;
}

export async function startDevdb(
  env: Record<string, string> = {},
  opts: { network?: StartedNetwork } = {},
): Promise<Devdb> {
  await buildImage();
  const endpointPorts = Array.from({ length: 10 }, (_, i) => 54300 + i);
  const exposedPorts = [4400, ...endpointPorts];
  const unstarted = new GenericContainer(IMAGE)
    .withEnvironment({ DEVDB_PORT_RANGE: "54300-54309", ...env })
    .withExposedPorts(...exposedPorts)
    .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
    .withStartupTimeout(240_000);
  // Task 15 (dynamic-pg-builds), additive: pg-builds.test.ts puts the daemon on a shared
  // user-defined network with its hermetic fixture registry (network alias `pgregistry`) so the
  // daemon's OCI client can dial it by name. Callers that omit `opts` keep the default bridge
  // network and the exact pre-existing behavior.
  if (opts.network) unstarted.withNetwork(opts.network);
  const container = await unstarted.start();
  assertAllPortsBound(container, exposedPorts);

  return {
    get base() {
      return `http://localhost:${container.getMappedPort(4400)}`;
    },
    container,
    mappedPort: (p) => {
      if (!exposedPorts.includes(p)) throw new Error(`port ${p} was not exposed by startDevdb() — add it to exposedPorts`);
      return container.getMappedPort(p);
    },
    async restart(options) {
      try {
        await container.restart(options);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(BIND_TIMEOUT_SIGNATURE)) throw e;
        // Docker occasionally (~1 in 60 restarts in the stress runs) takes >10s to republish
        // all 11 ports; the retry restarts again and re-polls from scratch, which recovers.
        await container.restart(options);
      }
      assertAllPortsBound(container, exposedPorts);
    },
    // milliseconds since testcontainers 11 (10.x read this field as seconds)
    stop: async () => { await container.stop({ timeout: 30_000 }); },
  };
}
