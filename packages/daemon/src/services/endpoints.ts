import type { BranchQueue } from "../state/queue.js";
import { PortExhaustedError } from "../compute/ports.js";
import { DevdbError } from "./errors.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";

export class EndpointsService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService }) {}

  async start(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      const project = this.deps.state.projects.byId(branch.projectId)!;
      if (this.deps.computes.statusOf(branch.id) === "running") {
        return this.deps.branches.detail(branch);
      }
      this.deps.state.branches.updateEndpoint(branch.id, { status: "starting", port: null });
      try {
        const { port } = await this.deps.computes.start({ branch, pgVersion: project.pgVersion });
        this.deps.state.branches.updateEndpoint(branch.id, { status: "running", port });
      } catch (e) {
        this.deps.state.branches.updateEndpoint(branch.id, { status: "failed", port: null });
        if (e instanceof PortExhaustedError) {
          const running = this.deps.computes.runningPorts()
            .map((r) => this.deps.state.branches.byId(r.branchId)?.name ?? r.branchId);
          throw new DevdbError(409,
            `no free endpoint port in range — running endpoints: ${running.join(", ")}. Stop one or widen DEVDB_PORT_RANGE.`);
        }
        throw e;
      }
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    });
  }

  async stop(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      this.deps.state.branches.updateEndpoint(branch.id, { status: "stopping", port: null });
      await this.deps.computes.stop(branch.id);
      this.deps.state.branches.updateEndpoint(branch.id, { status: "stopped", port: null });
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    });
  }

  async ensureRunning(branchId: string): Promise<BranchDetail> {
    if (this.deps.computes.statusOf(branchId) === "running") {
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    }
    return this.start(branchId);
  }
}
