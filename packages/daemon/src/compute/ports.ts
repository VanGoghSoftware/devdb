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

// Claim `port` into the shared `reserved` set, probe it, and give it back only if the probe grants
// it. The claim is added SYNCHRONOUSLY — before the probe's await — so two concurrent calls
// interleaving across that await can never settle on the same candidate (the claim lands atomically
// on the single-threaded event loop; the later call sees it and skips). The `finally` releases the
// claim on EVERY non-grant path — the probe returns false, OR the probe throws — so a candidate is
// never left claimed unless it was actually handed out. Returns true iff `port` is now the caller's
// (claimed + probe-approved); false means it was already reserved or the probe declined; a throwing
// probe propagates to the caller after its claim is released.
async function tryClaim(
  port: number,
  reserved: Set<number> | undefined,
  probe: (port: number) => Promise<boolean>,
): Promise<boolean> {
  if (reserved?.has(port)) return false;
  reserved?.add(port); // claim before the await — atomic against interleaved calls
  let granted = false;
  try {
    granted = await probe(port);
    return granted;
  } finally {
    if (!granted) reserved?.delete(port); // false OR threw: unclaim so nothing leaks
  }
}

// oracle: src/mgmt/compute/mod.rs:696-736 (sticky preferred port, then random, 100 attempts)
//
// Reserve-then-probe: every candidate is claimed into the shared `reserved` set (via tryClaim)
// SYNCHRONOUSLY — before the probe's await — so two allocatePort calls interleaving across that
// await can never settle on the same candidate. The old shape (probe first, caller adds to the set
// after this function resolved) was a TOCTOU race: two genuinely-parallel branch starts on distinct
// queue lanes could both probe the same free port, both pass (tryBind's throwaway server grants no
// exclusivity), both be handed it — and the second compute failed to bind at launch.
//
// Claim lifecycle: a candidate whose probe fails (returns false or throws) is unclaimed before we
// move on, and exhaustion throws with nothing left claimed. On success exactly the returned port
// remains claimed; RELEASING it is the caller's job (ComputeManager records it on its entry and
// deletes it from reservedPorts in stop() and in start()'s failure cleanup). `probe` is injectable
// so tests can drive the interleaving deterministically; production uses the real tryBind.
export async function allocatePort(
  range: { min: number; max: number },
  preferred?: number | null,
  reserved?: Set<number>,
  probe: (port: number) => Promise<boolean> = tryBind,
): Promise<number> {
  if (preferred && preferred >= range.min && preferred <= range.max) {
    if (await tryClaim(preferred, reserved, probe)) return preferred;
  }
  for (let i = 0; i < 100; i++) {
    const port = range.min + randomInt(range.max - range.min + 1);
    if (await tryClaim(port, reserved, probe)) return port;
  }
  throw new PortExhaustedError();
}
