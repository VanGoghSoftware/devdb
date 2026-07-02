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
export async function allocatePort(
  range: { min: number; max: number },
  preferred?: number | null,
  exclude?: ReadonlySet<number>,
): Promise<number> {
  if (
    preferred &&
    preferred >= range.min &&
    preferred <= range.max &&
    !exclude?.has(preferred) &&
    (await tryBind(preferred))
  ) {
    return preferred;
  }
  for (let i = 0; i < 100; i++) {
    const port = range.min + randomInt(range.max - range.min + 1);
    if (exclude?.has(port)) continue;
    if (await tryBind(port)) return port;
  }
  throw new PortExhaustedError();
}
