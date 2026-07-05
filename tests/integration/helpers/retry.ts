// Connection-teardown retry helper for the integration suite.
//
// A time-travel restore or a reset auto-stops+restarts the target branch's compute
// (TimeTravelService.swapOntoNewTimeline — the MCP restore_branch tool even documents it:
// "the endpoint is auto-stopped and restarted around it"). Severing live backends is inherent to
// swapping the timeline underneath a compute, not a bug: any connection open across it dies with
// 57P01 ("terminating connection due to administrator command"), and a FRESH connect+query issued
// right after the restart can still race the compute's final startup — under machine-level resource
// pressure (this repo's box is 10 CPUs / 8 GB, and Jordan runs parallel sessions) that window
// widens enough to occasionally drop the first connection/query with a socket-level error before
// postgres is stably accepting. This is the intermittent "compute-SIGTERM-mid-query" flake the full
// suite hits on timetravel.test.ts / mcp.test.ts (memory: integration-timetravel-fullsuite-flake) —
// it moves between files, always passes isolated, and is a load/timing property of the EXTERNAL
// client path (host -> testcontainers-published port -> compute), not a product defect.
//
// The correct client behaviour against a compute that was just restarted is to reconnect — exactly
// what a real external client or agent would do. These helpers give the tests that discipline
// without masking real failures: the classifier is deliberately narrow (connection-teardown
// signatures only), so a wrong-timeline restore ("relation ... does not exist"), a bad row count,
// or any assertion failure still surfaces on the first attempt.

// A connection torn down under us, or a compute not yet ready to accept one. Classified from TWO
// sources, matched separately so neither can spill into the other:
//
//   - `.code`: an EXACT SQLSTATE/errno token node-postgres puts on the error object. A code is a
//     discrete value, so matching it exactly (not as a substring) means a semantic error whose
//     MESSAGE merely happens to contain "57P01"/"57P03" is never misclassified as retriable:
//       57P01 backend terminated by administrator command (compute stopped mid-query on restore/reset)
//       57P03 postmaster starting up / shutting down / not yet accepting connections — the likeliest
//             shape for a FRESH connect racing a compute the restore/reset just restarted
//       ECONNREFUSED / ECONNRESET socket refused or reset while (re)connecting
const TRANSIENT_CONN_CODES = new Set(["57P01", "57P03", "ECONNREFUSED", "ECONNRESET"]);
//   - message: distinctive product/driver PHRASES for teardowns raised without a usable `.code`
//     (node-postgres' own "Connection terminated unexpectedly"; the daemon's /api/sql route relays
//     the pg error text in a 500 body with no code). The socket tokens are kept here too — they are
//     unambiguous, unlike bare SQLSTATE numbers — but the SQLSTATE NUMBERS are deliberately NOT in
//     this message regex, so semantic errors that mention a code in prose stay non-retriable.
const TRANSIENT_CONN_MESSAGES =
  /terminating connection due to administrator command|the database system is (starting up|shutting down|not yet accepting connections)|connection terminated|ECONNREFUSED|ECONNRESET/i;

export function isTransientConnError(e: unknown): boolean {
  if (e == null) return false;
  const rawCode = (e as { code?: unknown }).code;
  if (typeof rawCode === "string" && TRANSIENT_CONN_CODES.has(rawCode)) return true;
  const message = e instanceof Error ? e.message : String(e);
  return TRANSIENT_CONN_MESSAGES.test(message);
}

export interface RetryOpts {
  // Total attempts INCLUDING the first (so `attempts: 1` never retries). Default 5.
  attempts?: number;
  // Delay between attempts. Default 500ms — a compute's post-restart settle is sub-second in
  // practice; a handful of these covers the widened window under load without slowing the happy path.
  delayMs?: number;
  // Injectable sleep so unit tests can drive the retry loop without real wall-clock delay.
  sleep?: (ms: number) => Promise<void>;
  // Optional observer for each retried failure (e.g. to log which attempt reconnected).
  onRetry?: (attempt: number, err: unknown) => void;
}

// Runs `fn`, and while it throws an error `isRetriable` accepts, re-runs it up to `attempts` total,
// sleeping `delayMs` between tries. A non-retriable error propagates immediately; a retriable one
// that never clears propagates after the budget is spent (so a genuine failure still reds, just a
// few attempts later). `fn` MUST be idempotent — it is re-run verbatim.
export async function retryOnTransient<T>(
  fn: (attempt: number) => Promise<T>,
  isRetriable: (e: unknown) => boolean,
  opts: RetryOpts = {},
): Promise<T> {
  // Clamp to ≥1: `attempts` is the TOTAL number of tries, so 0 (or negative) is nonsensical — with
  // a bare `?? 5` it would skip the loop entirely and `throw lastErr` (undefined). No call site
  // passes it, but clamping makes the helper robust to one rather than throwing `undefined`.
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!isRetriable(e) || attempt === attempts) throw e;
      opts.onRetry?.(attempt, e);
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns on success or throws on the final attempt. Present so the
  // function is statically known to return T or throw.
  throw lastErr;
}

// Acquire a resource, use it, and ALWAYS release it — retrying the whole acquire+use+release cycle
// on a retriable error. `release` runs after every `use` (success OR failure). A failed ACQUIRE has
// no resource to release, so `acquire` owns its own failure cleanup (e.g. helpers/pg.ts's connect()
// closes a half-open client before rethrowing). `use` MUST be idempotent — it is re-run on a
// freshly acquired resource each attempt. This is the resource-safe core of withConnection
// (helpers/pg.ts); kept generic (no pg types) so its release-on-throw and re-acquire-per-retry
// behaviour is unit-testable without faking a pg.Client.
export async function withRetryableResource<R, T>(
  acquire: () => Promise<R>,
  use: (r: R) => Promise<T>,
  release: (r: R) => Promise<void>,
  isRetriable: (e: unknown) => boolean,
  opts: RetryOpts = {},
): Promise<T> {
  return retryOnTransient(
    async () => {
      const resource = await acquire();
      try {
        return await use(resource);
      } finally {
        // Release is best-effort and its outcome is discarded HERE, in the combinator, so a throwing
        // release can never (a) replace the value/error `use` produced — which is what the retry
        // classifier must see — nor (b) mis-drive the retry on a cleanup error. This is the generic
        // guarantee; callers need not pre-swallow their release.
        await release(resource).catch(() => {});
      }
    },
    isRetriable,
    opts,
  );
}
