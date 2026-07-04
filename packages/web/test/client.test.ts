import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api, ApiError, type RestoreBody } from "../src/api/client.js";

// Real jsdom `Response` objects (jsdom 29 implements the Fetch API) so the stub is fully typed —
// no `as any`/`as never` anywhere in this file, per the package's tsc gate.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("api client", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // `client.ts` only ever calls fetch with a string path, never a URL/Request object, and always
  // (when it passes init at all) an object literal — narrow the union down to what we assert on.
  function lastCall(): { url: string; init: RequestInit | undefined } {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    if (typeof url !== "string") throw new Error("expected client.ts to call fetch with a string path");
    return { url, init };
  }

  it("status: GET /api/status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: "1.0" }));
    const result = await api.status();
    expect(result).toEqual({ version: "1.0" });
    const { url, init } = lastCall();
    expect(url).toBe("/api/status");
    expect(init?.method).toBeUndefined();
  });

  describe("projects", () => {
    it("list: GET /api/projects", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: "p1" }]));
      const result = await api.projects.list();
      expect(result).toEqual([{ id: "p1" }]);
      const { url, init } = lastCall();
      expect(url).toBe("/api/projects");
      expect(init?.method).toBeUndefined();
    });

    it("create: POST /api/projects with JSON body", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { project: { id: "p1" }, mainBranch: { id: "b1" } }));
      const result = await api.projects.create({ name: "demo", pgVersion: 17 });
      expect(result).toEqual({ project: { id: "p1" }, mainBranch: { id: "b1" } });
      const { url, init } = lastCall();
      expect(url).toBe("/api/projects");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ name: "demo", pgVersion: 17 }));
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    });

    it("delete: DELETE /api/projects/:id, 204 resolves to undefined without parsing JSON", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      const result = await api.projects.delete("p1");
      expect(result).toBeUndefined();
      const { url, init } = lastCall();
      expect(url).toBe("/api/projects/p1");
      expect(init?.method).toBe("DELETE");
    });
  });

  describe("branches", () => {
    it("list: GET /api/projects/:projectId/branches", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: "b1" }]));
      const result = await api.branches.list("p1");
      expect(result).toEqual([{ id: "b1" }]);
      const { url, init } = lastCall();
      expect(url).toBe("/api/projects/p1/branches");
      expect(init?.method).toBeUndefined();
    });

    it("get: GET /api/branches/:id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1" }));
      const result = await api.branches.get("b1");
      expect(result).toEqual({ id: "b1" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1");
      expect(init?.method).toBeUndefined();
    });

    it("create: POST /api/projects/:projectId/branches with JSON body", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b2" }));
      const result = await api.branches.create("p1", { name: "feature", parentBranchId: "b1" });
      expect(result).toEqual({ id: "b2" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/projects/p1/branches");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ name: "feature", parentBranchId: "b1" }));
    });

    it("delete: DELETE /api/branches/:id, 204 resolves to undefined without parsing JSON", async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      const result = await api.branches.delete("b1");
      expect(result).toBeUndefined();
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1");
      expect(init?.method).toBe("DELETE");
    });

    it("rename: PATCH /api/branches/:id with {name} body", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1", name: "renamed" }));
      const result = await api.branches.rename("b1", "renamed");
      expect(result).toEqual({ id: "b1", name: "renamed" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1");
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ name: "renamed" }));
    });

    it("start: POST /api/branches/:id/endpoint/start", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1", endpointStatus: "starting" }));
      const result = await api.branches.start("b1");
      expect(result).toEqual({ id: "b1", endpointStatus: "starting" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1/endpoint/start");
      expect(init?.method).toBe("POST");
    });

    it("stop: POST /api/branches/:id/endpoint/stop", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1", endpointStatus: "stopping" }));
      const result = await api.branches.stop("b1");
      expect(result).toEqual({ id: "b1", endpointStatus: "stopping" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1/endpoint/stop");
      expect(init?.method).toBe("POST");
    });

    it("reset: POST /api/branches/:id/reset", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1" }));
      const result = await api.branches.reset("b1");
      expect(result).toEqual({ id: "b1" });
      const { url, init } = lastCall();
      expect(url).toBe("/api/branches/b1/reset");
      expect(init?.method).toBe("POST");
    });

    describe("restore", () => {
      it("sends {mode:'in_place', to} verbatim", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b1" }));
        const body: RestoreBody = { mode: "in_place", to: "2026-01-01T00:00:00Z" };
        await api.branches.restore("b1", body);
        const { url, init } = lastCall();
        expect(url).toBe("/api/branches/b1/restore");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify(body));
      });

      it("sends {mode:'new_branch', to, name} verbatim", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "b2" }));
        const body: RestoreBody = { mode: "new_branch", to: "2026-01-01T00:00:00Z", name: "restored" };
        await api.branches.restore("b1", body);
        const { url, init } = lastCall();
        expect(url).toBe("/api/branches/b1/restore");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify(body));
      });
    });
  });

  describe("error handling", () => {
    it("rejects with ApiError carrying the daemon's status and remediation message verbatim", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "branch has a running endpoint; stop it first" }));
      await expect(api.branches.reset("b1")).rejects.toSatisfy((e: unknown) => {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(409);
        expect((e as ApiError).message).toBe("branch has a running endpoint; stop it first");
        return true;
      });
    });

    it("falls back to HTTP <status> when the error body has no `error` field", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
      await expect(api.status()).rejects.toSatisfy((e: unknown) => {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(500);
        expect((e as ApiError).message).toBe("HTTP 500");
        return true;
      });
    });
  });
});
