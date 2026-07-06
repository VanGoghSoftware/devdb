import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

// oracle: neon libs/proxy/postgres-protocol2/src/password/mod.rs → scram_sha_256 — SCRAM-SHA-256
// is the engine-required verifier format (PBKDF2 salted password, HMAC "Client Key"/"Server Key",
// SHA-256 stored key, same "SCRAM-SHA-256$<iterations>:<salt>$<storedkey>:<serverkey>" layout).
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// DevDB's own secret policy: 32 alphanumerics.
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function generatePassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CHARSET[randomInt(CHARSET.length)];
  return out;
}
