import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "../src/supabase-api.js";

/** A fetch that never answers, but rejects when its signal aborts (like the real one). */
function hangingFetch() {
  const seen: AbortSignal[] = [];
  const impl = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) seen.push(signal);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { impl, seen };
}

describe("withRequestTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts a request that hangs, so the query fails instead of fetching forever", async () => {
    vi.useFakeTimers();
    const { impl } = hangingFetch();
    const result = withRequestTimeout(impl)("https://example.supabase.co/rest/v1/sessions").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await result) as Error).message).toMatch(/timed out/);
  });

  it("passes a response through and clears its timer", async () => {
    vi.useFakeTimers();
    const ok = new Response("[]", { status: 200 });
    const response = await withRequestTimeout(async () => ok, 1000)("https://x");
    expect(response).toBe(ok);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still honours the caller's own abort signal", async () => {
    const { impl, seen } = hangingFetch();
    const caller = new AbortController();
    const result = withRequestTimeout(impl, 60_000)("https://x", { signal: caller.signal }).catch((e: unknown) => e);
    caller.abort(new Error("cancelled by caller"));
    expect(((await result) as Error).message).toBe("cancelled by caller");
    expect(seen[0]?.aborted).toBe(true);
  });

  it("aborts at once if the caller's signal is already aborted", async () => {
    const { impl } = hangingFetch();
    const caller = new AbortController();
    caller.abort(new Error("already"));
    const result = await withRequestTimeout(impl, 60_000)("https://x", { signal: caller.signal }).catch((e: unknown) => e);
    expect((result as Error).message).toBe("already");
  });
});
