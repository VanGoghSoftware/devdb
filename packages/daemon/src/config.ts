import { isAbsolute, join } from "node:path";
import { z } from "zod";

const ENGINE_PORTS = {
  brokerPort: 50051,
  storconPort: 1234,
  storconDbPort: 5431,
  pageserverHttpPort: 9898,
  pageserverPgPort: 64000,
  safekeeperPgPort: 5454,
  safekeeperHttpPort: 7676,
  // oracle: src/preflight/mod.rs:17 TRACER_PORT = 4318 (reserved). The tracer sink (engine/tracer.ts)
  // binds this; the storage_controller's --control-plane-url + the binaries' OTLP exporter target it.
  tracerPort: 4318,
} as const;

const EnvSchema = z.object({
  DEVDB_HTTP_PORT: z.string().regex(/^\d+$/, "must be a decimal integer").default("4400"),
  DEVDB_DATA_DIR: z.string().trim().min(1),
  DEVDB_PORT_RANGE: z.string().regex(/^\d+-\d+$/).default("54300-54339"),
  NEON_BINARIES_DIR: z.string().trim().min(1),
  PG_INSTALL_DIR: z.string().trim().min(1),
  DEVDB_MCP_ALLOWED_HOSTS: z.string().optional(),
  DEVDB_MCP_ALLOWED_ORIGINS: z.string().optional(),
  DEVDB_WEB_DIST: z.string().optional(),
  DEVDB_PG_REGISTRY_BASE: z.string().optional(),
  DEVDB_PG_IMAGE_TEMPLATE: z.string().optional(),
});

export interface DevdbConfig {
  httpPort: number;
  dataDir: string;
  portRange: { min: number; max: number };
  neonBinDir: string;
  pgInstallDir: string;
  engine: {
    brokerPort: 50051;
    storconPort: 1234;
    storconDbPort: 5431;
    pageserverHttpPort: 9898;
    pageserverPgPort: 64000;
    safekeeperPgPort: 5454;
    safekeeperHttpPort: 7676;
    tracerPort: 4318;
  };
  mcpAllowedHosts: string[];
  mcpAllowedOrigins: string[];
  webDistDir: string | null;
  pgRegistryBase: string;
  pgImageTemplate: string;
  pgBuildsDir: string;
  pgDistribDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DevdbConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;

  for (const [name, value] of [
    ["DEVDB_DATA_DIR", e.DEVDB_DATA_DIR],
    ["NEON_BINARIES_DIR", e.NEON_BINARIES_DIR],
    ["PG_INSTALL_DIR", e.PG_INSTALL_DIR],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path, got: ${value}`);
    }
  }

  const httpPort = Number(e.DEVDB_HTTP_PORT);
  if (!(httpPort >= 1 && httpPort <= 65535)) {
    throw new Error(`DEVDB_HTTP_PORT out of range: ${httpPort}`);
  }

  const [minS, maxS] = e.DEVDB_PORT_RANGE.split("-") as [string, string];
  const min = Number(minS);
  const max = Number(maxS);
  if (!(min >= 1 && max >= min && max <= 65535)) {
    throw new Error(`DEVDB_PORT_RANGE invalid: ${e.DEVDB_PORT_RANGE}`);
  }

  // oracle: port constants from src/daemon/mod.rs + src/daemon/pageserver/mod.rs
  const reserved = Object.values(ENGINE_PORTS) as number[];
  const clash = reserved.find((p) => p >= min && p <= max);
  if (clash !== undefined) {
    throw new Error(
      `DEVDB_PORT_RANGE ${e.DEVDB_PORT_RANGE} overlaps reserved engine port ${clash} — pick a range clear of ${reserved.join(", ")}`,
    );
  }
  if (httpPort >= min && httpPort <= max) {
    throw new Error(`DEVDB_HTTP_PORT ${httpPort} falls inside DEVDB_PORT_RANGE ${e.DEVDB_PORT_RANGE}`);
  }
  if (reserved.includes(httpPort)) {
    throw new Error(`DEVDB_HTTP_PORT ${httpPort} is a reserved engine port`);
  }

  // Phase 3: directory of the built web UI (vite output). Unset => UI not served — the local-dev
  // daemon case, where `pnpm --filter @devdb/web dev` serves the SPA and proxies /api here.
  // The Docker image sets DEVDB_WEB_DIST=/app/packages/web/dist (docker/Dockerfile).
  const webDistDirRaw = e.DEVDB_WEB_DIST?.trim() ? e.DEVDB_WEB_DIST.trim() : null;
  if (webDistDirRaw !== null && !isAbsolute(webDistDirRaw)) {
    throw new Error(`DEVDB_WEB_DIST must be an absolute path, got: ${webDistDirRaw}`);
  }
  const webDistDir = webDistDirRaw;

  // Dynamic PG builds (spec 2026-07-04): overrides exist for mirrors/air-gap AND for the hermetic
  // integration fixture registry. http:// is allowed deliberately (the fixture, an in-network
  // registry:2, has no TLS) — the DEFAULT stays https to Docker Hub.
  const pgRegistryBase = (e.DEVDB_PG_REGISTRY_BASE?.trim() || "https://registry-1.docker.io").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(pgRegistryBase)) {
    throw new Error(`DEVDB_PG_REGISTRY_BASE must be an http(s) URL, got: ${pgRegistryBase}`);
  }
  const pgImageTemplate = e.DEVDB_PG_IMAGE_TEMPLATE?.trim() || "neondatabase/compute-node-v{major}";
  if (!pgImageTemplate.includes("{major}")) {
    throw new Error(`DEVDB_PG_IMAGE_TEMPLATE must contain the literal {major} placeholder, got: ${pgImageTemplate}`);
  }

  return {
    httpPort,
    dataDir: e.DEVDB_DATA_DIR,
    portRange: { min, max },
    neonBinDir: e.NEON_BINARIES_DIR,
    pgInstallDir: e.PG_INSTALL_DIR,
    engine: { ...ENGINE_PORTS },
    mcpAllowedHosts: e.DEVDB_MCP_ALLOWED_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    mcpAllowedOrigins: e.DEVDB_MCP_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    webDistDir,
    pgRegistryBase,
    pgImageTemplate,
    pgBuildsDir: join(e.DEVDB_DATA_DIR, "pg_builds"),
    pgDistribDir: join(e.DEVDB_DATA_DIR, "pg_distrib"),
  };
}
