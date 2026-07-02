import { execa } from "execa";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

const IMAGE = "devdb:dev";
let built = false;

export async function buildImage(): Promise<void> {
  if (built) return;
  await execa("docker", ["build", "-f", "docker/Dockerfile", "-t", IMAGE, "."], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: "inherit",
  });
  built = true;
}

export interface Devdb {
  base: string;
  container: StartedTestContainer;
  mappedPort(containerPort: number): number;
  stop(): Promise<void>;
}

export async function startDevdb(env: Record<string, string> = {}): Promise<Devdb> {
  await buildImage();
  const endpointPorts = Array.from({ length: 10 }, (_, i) => 54300 + i);
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ DEVDB_PORT_RANGE: "54300-54309", ...env })
    .withExposedPorts(4400, ...endpointPorts)
    .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();
  const base = `http://localhost:${container.getMappedPort(4400)}`;
  return {
    base,
    container,
    mappedPort: (p) => container.getMappedPort(p),
    stop: async () => { await container.stop({ timeout: 30_000 }); },
  };
}
