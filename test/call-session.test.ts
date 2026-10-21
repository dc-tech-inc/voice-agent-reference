import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { FakeProvider } from "../src/provider/fake-provider.js";
import { CallSession, type SessionOutput } from "../src/session/call-session.js";
import { appointmentTools } from "../src/tools/appointment-tools.js";
import { defineTool, ToolRegistry } from "../src/tools/registry.js";
import { InMemoryStore, seedSlots } from "../src/tools/store.js";
import { silentLogger } from "./helpers.js";

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
