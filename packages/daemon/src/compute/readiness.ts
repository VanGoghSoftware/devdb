// Readiness gate for compute_ctl: poll its auth-exempt Prometheus /metrics (external-http-port)
// for compute_ctl_up{status="running"}, which compute_ctl sets strictly AFTER apply_spec commits
// (handover §4.3/§8.7). This closes the first-ever-start SCRAM window that the old "listening on
// IPv4 address" needle raced (~80-140ms early). /status is NOT usable: it demands a JWT against an
// empty jwks (permanent 400; --dev does not bypass).

export function parseComputeCtlUpStatus(metricsText: string): string | null {
  const m = metricsText.match(/^compute_ctl_up\{[^}]*status="([^"]+)"[^}]*\}\s+1(?:\.0+)?\s*$/m);
  return m ? m[1]! : null;
}

// Upper bound on how long any SINGLE /metrics attempt is allowed to hang before it's abandoned
// and polling moves on. Review fix (Fix 2): the original loop only re-checked the overall deadline
// BETWEEN attempts — a hung TCP connect/headers/body on one `fetchImpl` call never resolved or
// rejected, so the loop never got back around to that check and start() hung forever (lane, ports,
// dir, compute_ctl all stuck). Every attempt is now individually time-boxed to
// min(time-left-until-deadline, this cap), so the overall deadline is always honored even when an
// individual fetch never settles on its own.
const PER_ATTEMPT_TIMEOUT_MS = 5_000;

// Rejects when `signal` aborts, otherwise resolves after `ms`. Used for the inter-poll sleep so an
// external `opts.signal` cancellation is honored promptly instead of waiting out the full
// `intervalMs` — the timer is always cleared on the way out (both branches), so this never leaks a
// handle under fake timers or in a real run.
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitComputeReady(
  metricsPort: number,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 50_000;
  const intervalMs = opts.intervalMs ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const externalSignal = opts.signal;
  const deadline = Date.now() + timeoutMs;

  const timeoutError = (lastStatus: string | null) =>
    new Error(`compute readiness timed out after ${timeoutMs}ms (last status=${lastStatus ?? "unreachable"}) on :${metricsPort}`);
  const externalAbortError = () =>
    externalSignal?.reason instanceof Error ? externalSignal.reason : new Error("compute readiness wait aborted");

  for (;;) {
    // Honor external cancellation PROMPTLY, before starting another attempt or sleep.
    if (externalSignal?.aborted) throw externalAbortError();

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(null);

    // Bound THIS attempt so a hung connect/headers/body can never prevent the deadline (or an
    // external abort) from being re-checked. A manual setTimeout-driven AbortController (rather
    // than `AbortSignal.timeout`) so this responds uniformly to fake timers in tests — Node's
    // `AbortSignal.timeout` schedules through its own internal timer wheel, which Vitest/Sinon
    // fake timers (patched globals only) cannot advance, making a "never-settling fetch" test
    // either hang or require real wall-clock waits. Always cleared via `finally` below so a
    // fast-resolving fetch never leaves a dangling timer.
    const attemptMs = Math.min(remainingMs, PER_ATTEMPT_TIMEOUT_MS);
    const attemptCtl = new AbortController();
    const attemptTimer = setTimeout(() => attemptCtl.abort(new Error("per-attempt readiness poll timed out")), attemptMs);
    const onExternalAbort = () => attemptCtl.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let status: string | null = null;
    try {
      const res = await fetchImpl(`http://127.0.0.1:${metricsPort}/metrics`, { signal: attemptCtl.signal });
      if (res.ok) {
        status = parseComputeCtlUpStatus(await res.text());
      } else {
        // Drain the body of non-OK responses so a repeated 404/500 during startup doesn't leave
        // sockets/bodies undrained across dozens of poll attempts.
        await res.body?.cancel?.().catch(() => {});
      }
    } catch {
      // Distinguish WHY this attempt didn't settle: an external cancellation must propagate
      // immediately (the caller asked us to stop), while our OWN per-attempt timeout — or any
      // other transient fetch failure (metrics server not up yet, connection refused, etc.) —
      // must be swallowed so polling continues until the overall deadline.
      if (externalSignal?.aborted) throw externalAbortError();
      // else: per-attempt timeout or transient failure — fall through and keep polling.
    } finally {
      clearTimeout(attemptTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    if (status === "running") return;
    if (status === "failed") throw new Error(`compute_ctl reported status="failed" on metrics port ${metricsPort}`);
    if (Date.now() >= deadline) throw timeoutError(status);

    const sleepMs = Math.min(intervalMs, deadline - Date.now());
    if (sleepMs > 0) await abortableSleep(sleepMs, externalSignal);
  }
}
