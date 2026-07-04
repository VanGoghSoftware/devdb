import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { api, type RestoreBody } from "./client.js";
import { keys } from "./keys.js";
import { mapEventToKeys, startEvents, type EventsStatus } from "./events.js";

export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: api.status });
}
export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.projects.list });
}
export function useBranches(projectId: string) {
  return useQuery({ queryKey: keys.branches(projectId), queryFn: () => api.branches.list(projectId) });
}
export function useBranch(id: string | null) {
  return useQuery({
    queryKey: keys.branch(id ?? "none"),
    queryFn: () => api.branches.get(id!),
    enabled: id !== null,
  });
}

function onError(e: unknown): void {
  notifications.show({ color: "red", title: "Request failed", message: e instanceof Error ? e.message : String(e) });
}

// One mutation-hook factory: run the call, toast failures with the daemon's remediation-bearing
// message, invalidate directly (UI-originated mutations don't wait for their event echo).
function useApiMutation<TArgs, TOut>(fn: (a: TArgs) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onError,
    onSettled: () => qc.invalidateQueries(),
  });
}

export function useCreateProject() { return useApiMutation(api.projects.create); }
export function useDeleteProject() { return useApiMutation(api.projects.delete); }
export function useCreateBranch() {
  return useApiMutation((a: { projectId: string; name: string; parentBranchId?: string }) =>
    api.branches.create(a.projectId, { name: a.name, parentBranchId: a.parentBranchId }));
}
export function useDeleteBranch() { return useApiMutation(api.branches.delete); }
export function useRenameBranch() {
  return useApiMutation((a: { id: string; name: string }) => api.branches.rename(a.id, a.name));
}
export function useStartEndpoint() { return useApiMutation(api.branches.start); }
export function useStopEndpoint() { return useApiMutation(api.branches.stop); }
export function useRestoreBranch() {
  return useApiMutation((a: { id: string; body: RestoreBody }) => api.branches.restore(a.id, a.body));
}
export function useResetBranch() { return useApiMutation(api.branches.reset); }

// Mounted ONCE in App. Blanket invalidate on every (re)connect; per-event mapped invalidation.
export function useEvents(): EventsStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<EventsStatus>("connecting");
  useEffect(() => {
    return startEvents({
      onOpen: () => void qc.invalidateQueries(),
      onEvent: (e) => { for (const k of mapEventToKeys(e)) void qc.invalidateQueries({ queryKey: k }); },
      onStatus: setStatus,
    });
  }, [qc]);
  return status;
}
