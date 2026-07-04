import type { EndpointStatus, PgVersion } from "@devdb/shared";
import type { TenantConfigJson } from "../engine/storcon-client.js";
import type { TimelineInfoJson } from "../engine/pageserver-client.js";
import type { BranchRow } from "../state/repos.js";

// Narrow structural interfaces containing exactly the methods services consume from the
// engine clients and compute manager. Services depend on these, not on the concrete classes,
// so unit tests can supply plainly-typed fakes (vi.fn stubs) without `as never` casts — the
// TypeScript compiler enforces that fakes actually satisfy what the service calls.
//
// Amendment A2 (controller): replaces the brief's `as never`-cast partial fakes with these
// typed interfaces + typed fakes. See task-12-report.md.

export interface StorconApi {
  tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void>;
  getLsnByTimestamp(tenantId: string, timelineId: string, isoTimestamp: string): Promise<{ lsn: string; kind: string }>;
}

export interface PageserverApi {
  timelineCreate(tenantId: string, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson>;
  timelineInfo(tenantId: string, timelineId: string): Promise<TimelineInfoJson>;
  timelineDelete(tenantId: string, timelineId: string): Promise<void>;
  timelineDetachAncestor(tenantId: string, timelineId: string): Promise<{ reparented_timelines: string[] }>;
  tenantDelete(tenantId: string): Promise<void>;
}

export interface SafekeeperApi {
  timelineDelete(tenantId: string, timelineId: string): Promise<void>;
  tenantDelete(tenantId: string): Promise<void>;
}

export interface ComputesApi {
  // Fix 1: `onLine`, when supplied, is registered as a listener at map-reservation time (before
  // any await inside ComputeManager.start()) so launch/failure output is never missed — see the
  // doc comment on ComputeManager.start() for the full rationale.
  //
  // Task 8 (dynamic-pg-builds): `pgbinPath` is REQUIRED, not derived from `pgVersion` inside
  // ComputeManager anymore — the caller (EndpointsService) resolves it fresh per start via
  // BuildsResolverApi.pgbinFor(project.pgVersion), which is what makes "adopt on restart"
  // structural: the ACTIVE build for a major can change between two starts of the same branch
  // with no code path here needing to know that happened.
  start(a: { branch: BranchRow; pgVersion: PgVersion; pgbinPath: string; onLine?: (line: string) => void }): Promise<{ port: number }>;
  stop(branchId: string): Promise<void>;
  statusOf(branchId: string): EndpointStatus;
  portOf(branchId: string): number | null;
  runningPorts(): Array<{ branchId: string; port: number }>;
  // The pgbin path a running (or starting/stopping) compute was launched with, or null once
  // stopped — BranchesService.detail() resolves this through BuildsResolverApi.versionForPgbin to
  // populate BranchDetail.runningPgVersion; BuildRegistry.assertRemovable uses runningPgbins() to
  // refuse deleting a build a live compute currently has open.
  runningPgbin(branchId: string): string | null;
  runningPgbins(): string[];
  onLine(branchId: string, cb: (line: string) => void): () => void;
  stopAll(): Promise<void>;
}

// Task 8: the narrow slice of BuildRegistry (compute/builds/registry.ts) services consume to
// resolve/record which on-disk Postgres build backs a compute start — named here (not imported
// from registry.ts directly) so services depend on a structural interface, matching every other
// *Api in this file, rather than the concrete class.
export interface BuildsResolverApi {
  // The currently-ACTIVE ready build for `major`, or throws DevdbError(409) naming a remediation
  // (pull one, or pick an installed major) when none is ready.
  pgbinFor(major: number): { path: string; version: string; buildId: string };
  // Reverse lookup: which registry row (by version string, e.g. "16.10") backs a given pgbin
  // path — null when the path doesn't match any known row (e.g. a gate candidate not yet adopted,
  // or the compute is stopped).
  versionForPgbin(pgbinPath: string): string | null;
  // Raises major's last-run-minor high-water mark (never lowers it) — called after a successful,
  // non-override start so a later downgrade attempt against an older build is caught.
  recordRun(major: number, minor: number): void;
  // Sorted majors with at least one ready build — the whitelist ProjectsService.create() checks a
  // requested pgVersion against.
  installedMajors(): number[];
}
