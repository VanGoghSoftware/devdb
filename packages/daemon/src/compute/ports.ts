import net from "node:net";
import { randomInt } from "node:crypto";

export class PortExhaustedError extends Error {
  constructor() {
    super("no free port in DEVDB_PORT_RANGE — stop an endpoint or widen the range");
  }
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// oracle: src/mgmt/compute/mod.rs:696-736 (sticky preferred port, then random, 100 attempts)
//
// Reserve-then-probe: every candidate is claimed into the shared `reserved` set SYNCHRONOUSLY —
// before the probe's await — so two allocatePort calls interleaving across that await can never
// settle on the same candidate (the claim lands atomically on the single-threaded event loop;
// the later call sees it and skips). The old shape (probe first, caller adds to the set after
// this function resolved) was a TOCTOU race: two genuinely-parallel branch starts on distinct
// queue lanes could both probe the same free port, both pass (tryBind's throwaway server grants
// no exclusivity), both be handed it — and the second compute failed to bind at launch.
//
// Claim lifecycle: a candidate whose probe fails is unclaimed before retrying, and exhaustion
// throws with nothing left claimed. On success exactly the returned port remains claimed;
// RELEASING it is the caller's job (ComputeManager records it on its entry and deletes it from
// reservedPorts in stop() and in start()'s failure cleanup). `probe` is injectable so tests can
// drive the interleaving deterministically; production uses the real tryBind.
export async function allocatePort(
  range: { min: number; max: number },
  preferred?: number | null,
  reserved?: Set<number>,
  probe: (port: number) => Promise<boolean> = tryBind,
): Promise<number> {
  if (
    preferred &&
    preferred >= range.min &&
    preferred <= range.max &&
    !reserved?.has(preferred)
  ) {
    reserved?.add(preferred); // claim before the await — atomic against interleaved calls
    if (await probe(preferred)) return preferred;
    reserved?.delete(preferred); // bind failed: unclaim, fall through to the random loop
  }
  for (let i = 0; i < 100; i++) {
    const port = range.min + randomInt(range.max - range.min + 1);
    if (reserved?.has(port)) continue;
    reserved?.add(port); // claim before the await — atomic against interleaved calls
    if (await probe(port)) return port;
    reserved?.delete(port); // genuinely bound elsewhere: unclaim, retry another candidate
  }
  throw new PortExhaustedError();
}
