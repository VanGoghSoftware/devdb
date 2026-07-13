import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { GenericContainer, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";

// Image under test. Defaults to devdb:dev (built from docker/Dockerfile by
// buildImage() below). Override with DEVDB_TEST_IMAGE to run the suite against a
// pre-built image supplied externally — e.g. a locally-built engine variant.
const IMAGE = process.env.DEVDB_TEST_IMAGE ?? "devdb:dev";

// Env-var prefix parameterization: the suite's daemon-env keys (and the one
// assertion that names an env var) are written against the DEVDB_ prefix;
// DEVDB_TEST_ENV_PREFIX rewrites them so the same suite drives an
// image whose daemon reads a different prefix (paired with DEVDB_TEST_IMAGE).
export const ENV_PREFIX = process.env.DEVDB_TEST_ENV_PREFIX ?? "DEVDB_";

function reprefix(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key.startsWith("DEVDB_") ? `${ENV_PREFIX}${key.slice("DEVDB_".length)}` : key] = value;
  }
  return out;
}

let built = false;

export async function buildImage(): Promise<void> {
  if (built) return;
  // When DEVDB_TEST_IMAGE is set the image is supplied pre-built by the caller;
  // do NOT rebuild it from docker/Dockerfile (that would clobber the external
  // image with a default-sourced one).
  if (process.env.DEVDB_TEST_IMAGE) {
    built = true;
    return;
  }
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
//
// The START path (GenericContainer.start()) hits the identical fixed-10s poll — via the same
// inspectContainerUntilPortsExposed() — and under real load (a full 14-file suite run, each file
// its own concurrent Vitest worker starting a container) it isn't rare: one run hit it on 4 of 14
// files. Unlike restart(), a failed start() throws with NO StartedTestContainer handle ever
// returned to the caller — read testcontainers@12.0.4's generic-container.js:
// GenericContainer.start() -> startContainer(): `client.container.create()` (container created),
// `client.container.start()` (container now RUNNING), then
// `inspectContainerUntilPortsExposed()` throws — all with no try/catch in between and no cleanup
// on the way out. The container testcontainers just created is left running in Docker,
// unreachable from JS (no handle to call .stop() on): a naive start() retry would leak one
// devdb:dev container per failed attempt. Ryuk (the session reaper) doesn't help here either —
// it's a process-exit/reconnection-timeout safety net, not an immediate per-attempt catch.
// startDevdb() below therefore gives each attempt a unique name (withName(), so concurrent files'
// retries can never collide on "name already in use") and on a BIND_TIMEOUT_SIGNATURE catch shells
// out to `docker rm -f <that name>` before retrying — precise (only ever removes the container
// this specific call just created) and safe to call even if the container was never created,
// since `docker rm -f` on a nonexistent name still resolves (exitCode 0), it doesn't reject.
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

// Bounded attempts for the start()-path retry (see T16 epilogue above). restart() retries once
// because its own stress run hit the timeout in ~1/60 restarts and a mid-retry failure there only
// costs one restart cycle. The start() path is both more failure-prone under load in practice (4
// concurrent timeouts in one 14-file suite run, i.e. a load-dependent — not rare — condition) and
// far more expensive to lose: a start() failure fails an entire test file's beforeAll, not one
// operation. 3 total attempts (2 retries) buys real headroom against that higher, load-correlated
// failure rate while still failing loudly if Docker is persistently unable to publish ports at all.
const START_MAX_ATTEMPTS = 3;

async function removeOrphanedContainer(name: string): Promise<void> {
  // Unconditional and best-effort: `docker rm -f` on a name that was never created (or already
  // removed) still resolves with exitCode 0 rather than rejecting, so there's no need to first
  // check whether this specific attempt actually got as far as `container create`.
  await execa("docker", ["rm", "-f", name], { reject: false });
}

export async function startDevdb(
  env: Record<string, string> = {},
  opts: { network?: StartedNetwork } = {},
): Promise<Devdb> {
  await buildImage();
  const endpointPorts = Array.from({ length: 10 }, (_, i) => 54300 + i);
  const exposedPorts = [4400, ...endpointPorts];

  const buildUnstarted = (name: string) => {
    // Auto-suspend is M5 (Go image only) and must never fire during the parity
    // run: a long-running test file would otherwise see a running endpoint flip
    // to "suspended" (spec D8 — the additive feature stays out of the parity
    // gate). Only inject it for the reprefixed (non-DEVDB_) cross-run; devdb's
    // own TS daemon has no such env and its runs are unchanged.
    const suspendOff: Record<string, string> = ENV_PREFIX === "DEVDB_" ? {} : { DEVDB_SUSPEND_TIMEOUT_SECONDS: "0" };
    const unstarted = new GenericContainer(IMAGE)
      .withName(name)
      .withEnvironment(reprefix({ DEVDB_PORT_RANGE: "54300-54309", ...suspendOff, ...env }))
      .withExposedPorts(...exposedPorts)
      .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
      .withStartupTimeout(240_000);
    // Task 15 (dynamic-pg-builds), additive: pg-builds.test.ts puts the daemon on a shared
    // user-defined network with its hermetic fixture registry (network alias `pgregistry`) so the
    // daemon's OCI client can dial it by name. Callers that omit `opts` keep the default bridge
    // network and the exact pre-existing behavior.
    if (opts.network) unstarted.withNetwork(opts.network);
    return unstarted;
  };

  let container: StartedTestContainer | undefined;
  for (let attempt = 1; attempt <= START_MAX_ATTEMPTS; attempt++) {
    // Unique per attempt: concurrent suite files each start their own devdb:dev container, so a
    // fixed/shared name would collide on retry across files ("name already in use") — see T16
    // epilogue above.
    const name = `devdb-test-${randomUUID()}`;
    try {
      container = await buildUnstarted(name).start();
      break;
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes(BIND_TIMEOUT_SIGNATURE)) throw e;
      // testcontainers' start() creates and starts the container BEFORE the port-poll that just
      // threw, and does not clean up on that failure (see T16 epilogue above) — reclaim it before
      // the next attempt so retries don't leak devdb:dev containers under repeated timeouts.
      await removeOrphanedContainer(name);
      if (attempt === START_MAX_ATTEMPTS) throw e;
    }
  }
  if (!container) throw new Error("startDevdb: unreachable — loop exited without starting or throwing");
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
