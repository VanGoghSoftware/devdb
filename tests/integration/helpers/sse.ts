// Minimal SSE consumer for integration tests: connects with fetch, yields each `data:` payload.
// Deliberately no EventSource dependency — undici's fetch streams the body directly.
export async function connectSse(url: string, signal: AbortSignal): Promise<AsyncGenerator<string>> {
  const res = await fetch(url, { signal });
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  async function* gen(): AsyncGenerator<string> {
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) yield line.slice(6);
        }
      }
    }
  }
  return gen();
}

export async function nextMatching(
  gen: AsyncGenerator<string>, pred: (payload: string) => boolean, timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SSE: no matching event before timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("SSE timeout")), remaining);
    });
    let race;
    try {
      race = await Promise.race([gen.next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (race.done) throw new Error("SSE stream ended before a matching event");
    if (pred(race.value)) return race.value;
  }
}
