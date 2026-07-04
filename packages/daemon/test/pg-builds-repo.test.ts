import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";

function mem() { return openState(":memory:"); }

describe("PgBuildsRepo", () => {
  it("insert + byId round-trips a downloaded row", () => {
    const s = mem();
    const row = s.pgBuilds.insert({
      id: "b1", major: 16, source: "downloaded", releaseTag: "9124",
      imageDigest: "sha256:abc", path: "/data/pg_builds/v16/9124", status: "downloading",
    });
    expect(row).toMatchObject({ id: "b1", major: 16, minor: null, active: false, sizeBytes: null, error: null });
    expect(s.pgBuilds.byId("b1")?.status).toBe("downloading");
  });

  it("setActiveExclusive clears any other active row of the SAME major only", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "a", major: 16, source: "baked", releaseTag: "baked", imageDigest: "", path: "/i/v16", status: "ready" });
    s.pgBuilds.insert({ id: "b", major: 16, source: "downloaded", releaseTag: "9124", imageDigest: "sha256:x", path: "/d/16", status: "ready" });
    s.pgBuilds.insert({ id: "c", major: 17, source: "baked", releaseTag: "baked", imageDigest: "", path: "/i/v17", status: "ready" });
    s.pgBuilds.setActiveExclusive("a");
    s.pgBuilds.setActiveExclusive("c");
    s.pgBuilds.setActiveExclusive("b");
    expect(s.pgBuilds.byId("a")?.active).toBe(false);
    expect(s.pgBuilds.byId("b")?.active).toBe(true);
    expect(s.pgBuilds.byId("c")?.active).toBe(true); // other major untouched
  });

  it("setDetected records minor+size; setStatus failed records error", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "b1", major: 17, source: "downloaded", releaseTag: "t", imageDigest: "sha256:y", path: "/p", status: "downloading" });
    s.pgBuilds.setDetected("b1", { minor: 5, sizeBytes: 1234 });
    s.pgBuilds.setStatus("b1", "failed", "gate: compute never became ready");
    const row = s.pgBuilds.byId("b1")!;
    expect(row).toMatchObject({ minor: 5, sizeBytes: 1234, status: "failed", error: "gate: compute never became ready" });
  });

  it("byMajorAndTag + byDigest find rows; delete removes", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "b1", major: 16, source: "downloaded", releaseTag: "9124", imageDigest: "sha256:z", path: "/p", status: "ready" });
    expect(s.pgBuilds.byMajorAndTag(16, "9124")?.id).toBe("b1");
    expect(s.pgBuilds.byDigest("sha256:z")?.id).toBe("b1");
    s.pgBuilds.delete("b1");
    expect(s.pgBuilds.byId("b1")).toBeNull();
  });

  it("two rows may share (major, release_tag) at different digests — tags are metadata, digests are identity", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "old", major: 17, source: "downloaded", releaseTag: "latest", imageDigest: "sha256:aaa", path: "/d/v17/aaa", status: "ready" });
    // A mutable-tag re-pull at a newer digest — the old UNIQUE(major, release_tag) made this throw.
    s.pgBuilds.insert({ id: "new", major: 17, source: "downloaded", releaseTag: "latest", imageDigest: "sha256:bbb", path: "/d/v17/bbb", status: "ready" });
    expect(s.pgBuilds.list().map((r) => r.id).sort()).toEqual(["new", "old"]);
  });

  it("setDigestPath fills digest+path on an in-flight row; byDigest prefers a ready row over a failed one at the same digest", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "r1", major: 17, source: "downloaded", releaseTag: "latest", imageDigest: "", path: "", status: "downloading" });
    s.pgBuilds.setDigestPath("r1", { imageDigest: "sha256:abc", path: "/d/v17/abc" });
    expect(s.pgBuilds.byId("r1")).toMatchObject({ imageDigest: "sha256:abc", path: "/d/v17/abc", status: "downloading" });

    // A later successful retry at the same digest must win the dedup lookup over the failed attempt.
    s.pgBuilds.setStatus("r1", "failed", "gate timed out after 90s");
    s.pgBuilds.insert({ id: "r2", major: 17, source: "downloaded", releaseTag: "latest", imageDigest: "sha256:abc", path: "/d/v17/abc2", status: "ready" });
    expect(s.pgBuilds.byDigest("sha256:abc")?.id).toBe("r2");
  });
});

describe("PgMajorsRepo", () => {
  it("recordRun is raise-only; setLastRunMinor is unconditional (consented rollback)", () => {
    const s = mem();
    expect(s.pgMajors.lastRunMinor(16)).toBeNull();
    s.pgMajors.recordRun(16, 9);
    s.pgMajors.recordRun(16, 8);          // lower — ignored
    expect(s.pgMajors.lastRunMinor(16)).toBe(9);
    s.pgMajors.recordRun(16, 10);
    expect(s.pgMajors.lastRunMinor(16)).toBe(10);
    s.pgMajors.setLastRunMinor(16, 9);    // consented rollback lowers
    expect(s.pgMajors.lastRunMinor(16)).toBe(9);
  });
});
