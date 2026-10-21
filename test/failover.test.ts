import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../src/provider/fake-provider.js";
import { CallSession, type SessionOutput } from "../src/session/call-session.js";
import { backoffDelay, DEFAULT_POLICY, sleep, withTimeout } from "../src/session/failover.js";
import { appointmentTools } from "../src/tools/appointment-tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryStore, seedSlots } from "../src/tools/store.js";
import { silentLogger } from "./helpers.js";

function makeSession(providers: FakeProvider[], random = () => 0.5) {
  const tools = new ToolRegistry(appointmentTools(new InMemoryStore(seedSlots(["2026-11-02"], ["room-a"], [9]))));
  const session = new CallSession({ providers, tools, instructions: "test", logger: silentLogger, random });
  const states: string[] = [];
  session.on((o: SessionOutput) => {
    if (o.type === "state") states.push(o.to);
  });
  return { session, states };
}

const chunk = (marker: number, ms = 100) => ({ pcm16: Buffer.alloc(ms * 48, marker), sampleRate: 24000 as const });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  it("is exponential with full jitter and capped", () => {
    const half = () => 0.5;
    expect([1, 2, 3, 4, 5, 6].map((r) => backoffDelay(r, DEFAULT_POLICY, half))).toEqual([125, 250, 500, 1000, 2000, 2000]);
    expect(backoffDelay(3, DEFAULT_POLICY, () => 0)).toBe(0);
    expect(backoffDelay(3, DEFAULT_POLICY, () => 0.999)).toBe(999);
  });
});

describe("helpers", () => {
  it("sleep ends early when aborted", async () => {
    const ac = new AbortController();
    let done = false;
    void sleep(10_000, ac.signal).then(() => (done = true));
    ac.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("withTimeout falls back on timeout and on rejection", async () => {
    const hanging = withTimeout(new Promise<boolean>(() => {}), 100, false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await hanging).toBe(false);
    expect(await withTimeout(Promise.reject(new Error("x")), 100, "fallback")).toBe("fallback");
    expect(await withTimeout(Promise.resolve("value"), 100, "fallback")).toBe("value");
  });
});

describe("failover", () => {
  it("activates the fallback when the primary never becomes ready", async () => {
    const primary = new FakeProvider("primary", { connectPlan: ["hang"] });
    const fallback = new FakeProvider("fallback");
    const { session, states } = makeSession([primary, fallback]);

    const started = session.start();
    await vi.advanceTimersByTimeAsync(3 * DEFAULT_POLICY.connectTimeoutMs + 1000);
    expect(await started).toBe("active");

    expect(primary.connectAttempts).toBe(3);
    expect(session.activeProvider).toBe("fallback");
    expect(states).toEqual(["connecting", "degraded", "degraded", "degraded", "active"]);
    expect(primary.closeCalls).toBe(3);
  });

  it("waits the backoff delay between attempts on the same provider", async () => {
    const primary = new FakeProvider("primary", { connectPlan: ["fail", "fail", "ok"] });
    const { session } = makeSession([primary, new FakeProvider("fallback")]);

    void session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(primary.connectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(124);
    expect(primary.connectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(primary.connectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(primary.connectAttempts).toBe(3);
    expect(session.activeProvider).toBe("primary");
  });

  it("skips further attempts on a provider that rejected the credentials", async () => {
    const primary = new FakeProvider("primary", { connectPlan: ["reject_auth"] });
    const fallback = new FakeProvider("fallback");
    const { session } = makeSession([primary, fallback]);
    await session.start();
    expect(primary.connectAttempts).toBe(1);
    expect(session.activeProvider).toBe("fallback");
  });

  it("moves an active call to the fallback when the primary drops", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session, states } = makeSession([primary, fallback]);
    await session.start();

    primary.crash("socket closed (1006)");
    await vi.advanceTimersByTimeAsync(0);

    expect(states).toEqual(["connecting", "active", "degraded", "active"]);
    expect(session.activeProvider).toBe("fallback");
    expect(primary.closeCalls).toBe(1);
  });

  it("fails over on a provider error event", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session } = makeSession([primary, fallback]);
    await session.start();
    primary.fail("server_error", "internal");
    await vi.advanceTimersByTimeAsync(0);
    expect(session.activeProvider).toBe("fallback");
  });

  it("does not return to a provider that failed with a non-retryable error", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session } = makeSession([primary, fallback]);
    await session.start();

    primary.fail("invalid_api_key", "bad key", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.activeProvider).toBe("fallback");

    fallback.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(primary.connectAttempts).toBe(1);
    expect(fallback.connectAttempts).toBe(2);
    expect(session.activeProvider).toBe("fallback");
  });

  it("ends the call after every provider used up its attempts", async () => {
    const primary = new FakeProvider("primary", { connectPlan: ["fail"] });
    const fallback = new FakeProvider("fallback", { connectPlan: ["fail"] });
    const { session, states } = makeSession([primary, fallback]);

    const started = session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await started).toBe("ended");

    expect(primary.connectAttempts).toBe(3);
    expect(fallback.connectAttempts).toBe(3);
    expect(states.at(-1)).toBe("ended");
    expect(states.filter((s) => s === "degraded")).toHaveLength(6);
  });

  it("fails over when a health check reports unhealthy", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session } = makeSession([primary, fallback]);
    await session.start();

    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.healthIntervalMs);
    expect(session.activeProvider).toBe("primary");

    primary.healthy = false;
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.healthIntervalMs);
    expect(session.activeProvider).toBe("fallback");
  });

  it("treats a health check that never answers as unhealthy", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session } = makeSession([primary, fallback]);
    await session.start();

    vi.spyOn(primary, "healthCheck").mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.healthIntervalMs + DEFAULT_POLICY.healthTimeoutMs);
    expect(session.activeProvider).toBe("fallback");
  });

  it("buffers at most 2 s of caller audio while degraded and keeps the newest", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback", { connectPlan: ["hang", "ok"] });
    const { session } = makeSession([primary, fallback]);
    await session.start();
    session.sendAudio(chunk(0));
    expect(primary.audioReceived).toHaveLength(1);

    primary.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("degraded");
    for (let i = 1; i <= 30; i++) session.sendAudio(chunk(i)); // 3 s of audio

    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.connectTimeoutMs + 1000);
    expect(session.activeProvider).toBe("fallback");
    const markers = fallback.audioReceived.map((c) => c.pcm16[0]);
    expect(markers).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));

    session.sendAudio(chunk(99));
    expect(fallback.audioReceived.at(-1)?.pcm16[0]).toBe(99);
  });
});
