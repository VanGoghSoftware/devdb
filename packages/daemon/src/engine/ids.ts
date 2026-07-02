import { randomUUID } from "node:crypto";

export function newHexId(): string {
  return randomUUID().replaceAll("-", "");
}
export function uuidToHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

const ENGINE_ID_RE = /^[0-9a-f]{32}$/;
export function assertEngineId(id: string): string {
  if (!ENGINE_ID_RE.test(id)) {
    throw new Error(`invalid engine id: ${JSON.stringify(id)} (expected 32 lowercase hex chars)`);
  }
  return id;
}
