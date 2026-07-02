import { describe, expect, it } from "vitest";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { scramSha256Verifier, generatePassword } from "../src/compute/scram.js";
import { computePostgresqlConf, PG_HBA } from "../src/compute/pgconf.js";
import { computeConfigJson } from "../src/compute/spec.js";

describe("scram", () => {
  it("produces a valid RFC 5803 verifier", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8");
    const v = scramSha256Verifier("secret", salt);
    const m = v.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
    expect(m).not.toBeNull();
    const [, iter, saltB64, storedB64, serverB64] = m!;
    expect(Number(iter)).toBe(4096);
    expect(Buffer.from(saltB64!, "base64")).toEqual(salt);
    const salted = pbkdf2Sync("secret", salt, 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    expect(Buffer.from(storedB64!, "base64")).toEqual(createHash("sha256").update(clientKey).digest());
    expect(Buffer.from(serverB64!, "base64")).toEqual(createHmac("sha256", salted).update("Server Key").digest());
  });
  it("generatePassword is 32 alphanumerics", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9]{32}$/);
  });
  it("generates a fresh 16-byte salt per call", () => {
    const a = scramSha256Verifier("secret");
    const b = scramSha256Verifier("secret");
    expect(a).not.toBe(b);
    const salt = Buffer.from(a.match(/^SCRAM-SHA-256\$\d+:([^$]+)\$/)![1]!, "base64");
    expect(salt.length).toBe(16);
  });
  it("binds a custom iteration count into prefix and keys", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8");
    const v = scramSha256Verifier("secret", salt, 8192);
    expect(v.startsWith("SCRAM-SHA-256$8192:")).toBe(true);
    const salted = pbkdf2Sync("secret", salt, 8192, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    expect(v).toContain(createHash("sha256").update(clientKey).digest("base64"));
  });
});

describe("postgresql.conf", () => {
  it("carries the oracle settings minus TLS", () => {
    const conf = computePostgresqlConf({ port: 54321, hbaPath: "/x/pg_hba.conf" });
    for (const line of [
      "shared_buffers=128MB", "fsync=off", "wal_level=logical",
      // CONFIRMED live (Task 14): unquoted "0.0.0.0" is a real postgresql.conf syntax error
      // (Postgres's GUC lexer tokenizes on the dots) — quoted like the other string GUCs below.
      "listen_addresses='0.0.0.0'", "port=54321", "shared_preload_libraries=neon",
      "synchronous_standby_names=walproposer", "neon.safekeepers=localhost:5454",
      "password_encryption=scram-sha-256", "hba_file='/x/pg_hba.conf'",
    ]) expect(conf, line).toContain(line);
    expect(conf).not.toContain("ssl=on");
    expect(conf).not.toContain("ssl_cert_file");
  });
  it("pg_hba keeps scram for remote, trust for local cloud_admin, no hostssl", () => {
    expect(PG_HBA).toContain("local   all       cloud_admin                 trust");
    expect(PG_HBA).toContain("host    all       cloud_admin   127.0.0.1/32  trust");
    expect(PG_HBA).toContain("host    all       cloud_admin   ::1/128       trust");
    expect(PG_HBA).not.toContain("::1/32 ");
    expect(PG_HBA).toContain("host    all       all           all           scram-sha-256");
    expect(PG_HBA).not.toContain("hostssl");
  });
  it("quotes hba_file paths with spaces and quotes", () => {
    const conf = computePostgresqlConf({ port: 1, hbaPath: "/da ta/it's/pg_hba.conf" });
    expect(conf).toContain("hba_file='/da ta/it''s/pg_hba.conf'");
  });
});

describe("compute config json", () => {
  it("matches the oracle ComputeSpec shape (trust mode)", () => {
    const doc = JSON.parse(computeConfigJson({
      tenantIdHex: "a".repeat(32), timelineIdHex: "b".repeat(32),
      port: 54321, hbaPath: "/x/pg_hba.conf", password: "pw",
    }));
    const spec = doc.spec;
    expect(spec.format_version).toBe(1.0);
    expect(spec.cluster.roles[0].name).toBe("postgres");
    expect(spec.cluster.roles[0].encrypted_password).toMatch(/^SCRAM-SHA-256\$/);
    expect(spec.cluster.databases[0]).toMatchObject({ name: "postgres", owner: "postgres" });
    expect(spec.tenant_id).toBe("a".repeat(32));
    expect(spec.timeline_id).toBe("b".repeat(32));
    expect(spec.pageserver_connstring).toBe("postgres://cloud_admin@127.0.0.1:64000");
    expect(spec.safekeeper_connstrings).toEqual(["127.0.0.1:5454"]);
    expect(spec.mode).toBe("Primary");
    expect(spec.endpoint_id).toBe(`compute-${"b".repeat(32)}`);
    expect(spec.suspend_timeout_seconds).toBe(-1);
    expect(spec.storage_auth_token).toBeUndefined();
    // CONFIRMED live (Task 14): compute_ctl's deserializer requires `jwks` present as a single
    // jsonwebtoken::jwk::JwkSet object (`{ keys: [...] }`), not an array of them — see spec.ts's
    // comment for the two live errors that pinned this shape down.
    expect(doc.compute_ctl_config).toEqual({ jwks: { keys: [] } });
  });
  it("rejects malformed ids in compute config", () => {
    expect(() => computeConfigJson({
      tenantIdHex: "not-hex", timelineIdHex: "b".repeat(32),
      port: 1, hbaPath: "/x", password: "pw",
    })).toThrow(/invalid engine id/);
  });
  it("pins pageserver_connection_info exactly", () => {
    const doc = JSON.parse(computeConfigJson({
      tenantIdHex: "a".repeat(32), timelineIdHex: "b".repeat(32),
      port: 54321, hbaPath: "/x/pg_hba.conf", password: "pw",
    }));
    expect(doc.spec.pageserver_connection_info).toEqual({
      shard_count: 0,
      stripe_size: null,
      shards: { "0000": { pageservers: [{ id: 1, libpq_url: "postgres://cloud_admin@127.0.0.1:64000", grpc_url: null }] } },
      prefer_protocol: "libpq",
    });
  });
});
