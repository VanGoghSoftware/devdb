import { useEffect, useRef, useState } from "react";
import { Group, ScrollArea, Switch, Text } from "@mantine/core";

const MAX_LINES = 500; // mirror the server-side ring

export function LogsTab(a: { branchId: string; makeSource?: (url: string) => EventSource }) {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const make = a.makeSource ?? ((u: string) => new EventSource(u));
    // The logs SSE replays the recent ring then tails live (api.ts sse()); each event's data is a
    // JSON-encoded string line. EventSource's native auto-reconnect + the server's replay make a
    // simple always-reconnect client correct here (unlike /api/events, which needs owned backoff).
    const es = make(`/api/branches/${a.branchId}/logs`);
    es.onmessage = (m) => {
      try {
        const line: unknown = JSON.parse(m.data as string);
        if (typeof line === "string") setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
      } catch { /* non-JSON frame — ignore */ }
    };
    return () => es.close();
  }, [a.branchId, a.makeSource]);

  useEffect(() => {
    // Optional-call guard: jsdom's HTMLElement has no scrollTo implementation — the follow
    // behavior is real-browser-only, and tests must not crash on the missing method.
    if (follow) viewport.current?.scrollTo?.({ top: viewport.current.scrollHeight });
  }, [lines, follow]);

  return (
    <>
      <Group justify="flex-end" py={4}>
        <Switch size="xs" label="follow" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
      </Group>
      <ScrollArea h={320} viewportRef={viewport} bg="dark.8" style={{ borderRadius: 6 }}>
        <div style={{ padding: 8 }}>
          {lines.length === 0 && <Text size="xs" c="dimmed" p="xs">no output yet — start the endpoint or run a query</Text>}
          {lines.map((l, i) => (
            <Text key={i} data-testid="log-line" ff="monospace" size="xs" c="green.3" style={{ whiteSpace: "pre-wrap" }}>{l}</Text>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}
