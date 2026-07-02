import { randomUUID } from "node:crypto";

export function newHexId(): string {
  return randomUUID().replaceAll("-", "");
}
export function uuidToHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}
