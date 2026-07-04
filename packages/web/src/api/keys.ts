export const keys = {
  status: ["status"] as const,
  projects: ["projects"] as const,
  branches: (projectId: string) => ["branches", projectId] as const,
  allBranches: ["branches"] as const,
  branch: (id: string) => ["branch", id] as const,
};
