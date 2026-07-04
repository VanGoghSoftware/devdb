import type { BranchDto, ProjectDto, StatusDto, BranchContext } from "@devdb/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Daemon errors carry remediation-bearing messages (phase-2 convention) — surface verbatim.
    const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export type RestoreBody =
  | { mode: "in_place"; to: string }
  | { mode: "new_branch"; to: string; name: string };

export const api = {
  status: () => req<StatusDto>("/api/status"),
  projects: {
    list: () => req<ProjectDto[]>("/api/projects"),
    create: (b: { name: string; pgVersion?: number }) =>
      req<{ project: ProjectDto; mainBranch: BranchDto }>("/api/projects", { method: "POST", body: JSON.stringify(b) }),
    delete: (id: string) => req<void>(`/api/projects/${id}`, { method: "DELETE" }),
  },
  branches: {
    list: (projectId: string) => req<BranchDto[]>(`/api/projects/${projectId}/branches`),
    get: (id: string) => req<BranchDto>(`/api/branches/${id}`),
    create: (projectId: string, b: { name: string; parentBranchId?: string; context?: BranchContext }) =>
      req<BranchDto>(`/api/projects/${projectId}/branches`, { method: "POST", body: JSON.stringify(b) }),
    delete: (id: string) => req<void>(`/api/branches/${id}`, { method: "DELETE" }),
    rename: (id: string, name: string) =>
      req<BranchDto>(`/api/branches/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    start: (id: string) => req<BranchDto>(`/api/branches/${id}/endpoint/start`, { method: "POST" }),
    stop: (id: string) => req<BranchDto>(`/api/branches/${id}/endpoint/stop`, { method: "POST" }),
    restore: (id: string, body: RestoreBody) =>
      req<BranchDto>(`/api/branches/${id}/restore`, { method: "POST", body: JSON.stringify(body) }),
    reset: (id: string) => req<BranchDto>(`/api/branches/${id}/reset`, { method: "POST" }),
  },
};
