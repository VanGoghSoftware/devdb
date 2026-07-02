import { z } from "zod";

const EnvSchema = z.object({
  DEVDB_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  DEVDB_DATA_DIR: z.string().min(1),
  DEVDB_PORT_RANGE: z.string().regex(/^\d+-\d+$/).default("54300-54339"),
  NEON_BINARIES_DIR: z.string().min(1),
  PG_INSTALL_DIR: z.string().min(1),
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
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DevdbConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;
  const [minS, maxS] = e.DEVDB_PORT_RANGE.split("-") as [string, string];
  const min = Number(minS);
  const max = Number(maxS);
  if (!(min > 0 && max >= min && max <= 65535)) {
    throw new Error(`DEVDB_PORT_RANGE invalid: ${e.DEVDB_PORT_RANGE}`);
  }
  return {
    httpPort: e.DEVDB_HTTP_PORT,
    dataDir: e.DEVDB_DATA_DIR,
    portRange: { min, max },
    neonBinDir: e.NEON_BINARIES_DIR,
    pgInstallDir: e.PG_INSTALL_DIR,
    // oracle: port constants from src/daemon/mod.rs + src/daemon/pageserver/mod.rs
    engine: {
      brokerPort: 50051,
      storconPort: 1234,
      storconDbPort: 5431,
      pageserverHttpPort: 9898,
      pageserverPgPort: 64000,
      safekeeperPgPort: 5454,
      safekeeperHttpPort: 7676,
    },
  };
}
