import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

// oracle: postgres_protocol::password::scram_sha_256 (used at src/mgmt/compute/mod.rs:580)
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// oracle: src/utils/password.rs — 32 alphanumerics
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function generatePassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CHARSET[randomInt(CHARSET.length)];
  return out;
}
