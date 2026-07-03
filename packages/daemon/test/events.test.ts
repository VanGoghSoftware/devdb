import { describe, expect, it } from "vitest";
import { DevdbEventSchema } from "@devdb/shared";
import { EventsService } from "../src/services/events.js";

describe("EventsService", () => {
  it("delivers published events to subscribers with a server timestamp", () => {
    const svc = new EventsService();
    const seen: unknown[] = [];
    svc.subscribe((e) => seen.push(e));
    svc.publish({ type: "branch.created", projectId: "p1", branchId: "b1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "branch.created", projectId: "p1", branchId: "b1" });
    expect(new Date((seen[0] as { at: string }).at).toString()).not.toBe("Invalid Date");
  });

  it("unsubscribe stops delivery; other subscribers unaffected", () => {
    const svc = new EventsService();
    const a: unknown[] = []; const b: unknown[] = [];
    const unsubA = svc.subscribe((e) => a.push(e));
    svc.subscribe((e) => b.push(e));
    unsubA();
    svc.publish({ type: "engine.health" });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("a throwing subscriber never breaks delivery to the rest (LogsService swallow contract)", () => {
    const svc = new EventsService();
    const seen: unknown[] = [];
    svc.subscribe(() => { throw new Error("boom"); });
    svc.subscribe((e) => seen.push(e));
    expect(() => svc.publish({ type: "project.deleted", projectId: "p1" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("a subscriber that unsubscribes itself mid-publish does not skip others", () => {
    const svc = new EventsService();
    const seen: string[] = [];
    const unsub = svc.subscribe(() => { seen.push("self"); unsub(); });
    svc.subscribe(() => seen.push("other"));
    svc.publish({ type: "engine.health" });
    expect(seen).toEqual(["self", "other"]);
  });

  it("DevdbEventSchema rejects non-contract fields and accepts a valid event", () => {
    expect(DevdbEventSchema.safeParse({ type: "engine.health", at: "t" }).success).toBe(true);
    expect(DevdbEventSchema.safeParse({ type: "engine.health", at: "t", data: "leak" }).success).toBe(false);
  });
});
