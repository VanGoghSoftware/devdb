// Readiness gate for compute_ctl: poll its auth-exempt Prometheus /metrics (external-http-port)
// for compute_ctl_up{status="running"}, which compute_ctl sets strictly AFTER apply_spec commits
// (handover §4.3/§8.7). This closes the first-ever-start SCRAM window that the old "listening on
// IPv4 address" needle raced (~80-140ms early). /status is NOT usable: it demands a JWT against an
// empty jwks (permanent 400; --dev does not bypass).

export function parseComputeCtlUpStatus(metricsText: string): string | null {
  const m = metricsText.match(/^compute_ctl_up\{[^}]*status="([^"]+)"[^}]*\}\s+1(?:\.0+)?\s*$/m);
  return m ? m[1]! : null;
}

export async function waitComputeReady(
  metricsPort: number,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 50_000;
  const intervalMs = opts.intervalMs ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: string | null = null;
    try {
      const res = await fetchImpl(`http://127.0.0.1:${metricsPort}/metrics`, { signal: opts.signal });
      if (res.ok) status = parseComputeCtlUpStatus(await res.text());
    } catch {
      // metrics server not up yet, or a transient — keep polling until the deadline
    }
    if (status === "running") return;
    if (status === "failed") throw new Error(`compute_ctl reported status="failed" on metrics port ${metricsPort}`);
    if (Date.now() > deadline) {
      throw new Error(`compute readiness timed out after ${timeoutMs}ms (last status=${status ?? "unreachable"}) on :${metricsPort}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
