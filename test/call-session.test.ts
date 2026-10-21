import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { FakeProvider } from "../src/provider/fake-provider.js";
import { CallSession, type SessionOutput } from "../src/session/call-session.js";
import { appointmentTools } from "../src/tools/appointment-tools.js";
import { defineTool, ToolRegistry } from "../src/tools/registry.js";
import { InMemoryStore, seedSlots } from "../src/tools/store.js";
import { memoryLogger, silentLogger } from "./helpers.js";

function setup(providers = [new FakeProvider("primary"), new FakeProvider("fallback")], registry?: ToolRegistry) {
  const store = new InMemoryStore(seedSlots(["2026-11-02"], ["room-a"], [9, 10]));
  const tools = registry ?? new ToolRegistry(appointmentTools(store));
  const session = new CallSession({ providers, tools, instructions: "You run an appointment desk.", logger: silentLogger });
  const outputs: SessionOutput[] = [];
  session.on((o) => outputs.push(o));
  return { session, store, outputs, providers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CallSession", () => {
  it("requires at least one provider", () => {
    expect(
      () => new CallSession({ providers: [], tools: new ToolRegistry([]), instructions: "", logger: silentLogger }),
    ).toThrow(/at least one provider/);
  });

  it("passes instructions and tool schemas to the provider", async () => {
    const { session, providers } = setup();
    await session.start();
    expect(providers[0]!.tools.map((t) => t.name)).toEqual(["list_available_slots", "book_slot", "cancel_booking"]);
  });

  it("runs a tool call end to end and returns the result to the provider", async () => {
    const { session, store, outputs, providers } = setup();
    const primary = providers[0]!;
    await session.start();

    primary.userSays("Book the 9 o'clock slot for Alex, 555-0100.");
    const result = primary.nextToolResult();
    primary.callTool("book_slot", { slotId: "room-a-2026-11-02T09", name: "Alex", contact: "555-0100" }, "call_1");
    expect(await result).toEqual({ callId: "call_1", name: "book_slot", output: { ok: true, bookingId: "bk_1" } });
    primary.agentSays("You're booked.");

    expect(store.bookingCount).toBe(1);
    expect(outputs.filter((o) => o.type === "transcript").map((o) => (o as { text: string }).text)).toEqual([
      "Book the 9 o'clock slot for Alex, 555-0100.",
      "You're booked.",
    ]);
    expect(outputs.some((o) => o.type === "tool" && o.name === "book_slot")).toBe(true);
    expect(outputs.some((o) => o.type === "audio")).toBe(true);
  });

  it("returns VALIDATION_ERROR to the model and does not touch the store", async () => {
    const { session, store, providers } = setup();
    const primary = providers[0]!;
    await session.start();
    const result = primary.nextToolResult();
    primary.callTool("book_slot", { slotId: "room-a-2026-11-02T09" });
    expect((await result).output).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    expect(store.bookingCount).toBe(0);
  });

  it("drops a tool result when the provider failed while the tool was running", async () => {
    vi.useFakeTimers();
    const slow = new ToolRegistry([
      defineTool({
        name: "slow",
        description: "",
        input: z.object({}),
        handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)),
      }),
    ]);
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session } = setup([primary, fallback], slow);
    await session.start();

    primary.callTool("slow", {});
    primary.crash();
    await vi.advanceTimersByTimeAsync(1000);

    expect(session.activeProvider).toBe("fallback");
    expect(primary.toolResults).toEqual([]);
    expect(fallback.toolResults).toEqual([]);
  });

  it("drops a tool result issued on the previous connection of the same provider", async () => {
    vi.useFakeTimers();
    const { logger, lines } = memoryLogger("warn");
    const slow = new ToolRegistry([
      defineTool({
        name: "slow",
        description: "",
        input: z.object({}),
        handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)),
      }),
    ]);
    const only = new FakeProvider("only"); // e.g. only OPENAI_API_KEY is set
    const session = new CallSession({ providers: [only], tools: slow, instructions: "", logger });
    await session.start();

    only.callTool("slow", {}, "call_from_connection_1");
    only.crash("socket closed (1006)");
    await vi.advanceTimersByTimeAsync(0);
    expect(session.activeProvider).toBe("only");
    expect(only.connectAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(only.toolResults).toEqual([]);
    expect(lines.some((l) => l.includes("dropping tool result"))).toBe(true);
  });

  it("hangup ends the call, closes the provider and ignores later audio", async () => {
    const { session, providers, outputs } = setup();
    const primary = providers[0]!;
    await session.start();

    await session.hangup("caller hung up");
    expect(session.state).toBe("ended");
    expect(primary.closeCalls).toBe(1);
    expect(outputs.at(-1)).toEqual({ type: "state", from: "active", to: "ended", reason: "caller hung up" });

    session.sendAudio({ pcm16: Buffer.alloc(10), sampleRate: 24000 });
    expect(primary.audioReceived).toHaveLength(0);
    await session.hangup();
    expect(primary.closeCalls).toBe(1);
  });

  it("hangup while connecting stops the retry loop", async () => {
    vi.useFakeTimers();
    const primary = new FakeProvider("primary", { connectPlan: ["hang"] });
    const { session } = setup([primary, new FakeProvider("fallback")]);
    const started = session.start();
    await vi.advanceTimersByTimeAsync(1000);
    await session.hangup("shutdown");
    expect(await started).toBe("ended");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(primary.connectAttempts).toBe(1);
  });

  it("ignores events from a provider that is no longer active", async () => {
    const primary = new FakeProvider("primary");
    const fallback = new FakeProvider("fallback");
    const { session, outputs } = setup([primary, fallback]);
    await session.start();
    primary.crash();
    await new Promise((r) => setImmediate(r));
    const before = outputs.length;
    primary.userSays("late event");
    expect(outputs.length).toBe(before);
  });
});

describe("CallSession lifecycle edge cases", () => {
  it("hangup from a state listener on 'active' leaves no timers running", async () => {
    vi.useFakeTimers();
    const p = new FakeProvider("p");
    const { session } = setup([p]);
    session.on((o) => {
      if (o.type === "state" && o.to === "active") void session.hangup("caller already gone");
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("ended");
    expect(p.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never leaves a provider connected when hangup races a successful connect", async () => {
    const leaks: number[] = [];
    for (let ticks = 0; ticks < 30; ticks++) {
      const p = new FakeProvider("p");
      const { session } = setup([p]);
      const started = session.start();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      await session.hangup();
      await started;
      if (p.isConnected) leaks.push(ticks);
    }
    expect(leaks).toEqual([]);
  });

  it("logs caller audio that was dropped when the call ends while degraded", async () => {
    vi.useFakeTimers();
    const { logger, lines } = memoryLogger("warn");
    const a = new FakeProvider("a", { connectPlan: ["ok", "fail"] });
    const b = new FakeProvider("b", { connectPlan: ["fail"] });
    const session = new CallSession({ providers: [a, b], tools: new ToolRegistry([]), instructions: "", logger });
    await session.start();
    a.crash();
    for (let i = 0; i < 30; i++) session.sendAudio({ pcm16: Buffer.alloc(4800), sampleRate: 24000 }); // 3 s
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state).toBe("ended");
    expect(lines.some((l) => l.includes("dropped caller audio"))).toBe(true);
  });

  it("rejects an invalid failover policy at construction", () => {
    const make = (policy: object) => () =>
      new CallSession({ providers: [new FakeProvider("p")], tools: new ToolRegistry([]), instructions: "", logger: silentLogger, policy });
    expect(make({ maxAttemptsPerProvider: 0 })).toThrow(/invalid failover policy: maxAttemptsPerProvider/);
    expect(make({ connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
    expect(make({ backoffBaseMs: 0 })).not.toThrow();
  });

  it("logs instead of crashing when a provider throws while receiving a tool result", async () => {
    const { logger, lines } = memoryLogger("error");
    const p = new FakeProvider("p");
    vi.spyOn(p, "sendToolResult").mockImplementation(() => {
      throw new Error("socket write failed");
    });
    const session = new CallSession({
      providers: [p],
      tools: new ToolRegistry(appointmentTools(new InMemoryStore([]))),
      instructions: "",
      logger,
    });
    await session.start();
    p.callTool("cancel_booking", { bookingId: "bk_1" });
    await vi.waitFor(() => expect(lines.some((l) => l.includes("tool dispatch failed"))).toBe(true));
  });
});
