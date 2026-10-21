import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { appointmentTools } from "../src/tools/appointment-tools.js";
import { defineTool, ToolRegistry } from "../src/tools/registry.js";
import { InMemoryStore, seedSlots } from "../src/tools/store.js";

const DATE = "2026-11-02";
let store: InMemoryStore;
let registry: ToolRegistry;

beforeEach(() => {
  store = new InMemoryStore(seedSlots([DATE], ["room-a", "room-b"], [9, 10]));
  registry = new ToolRegistry(appointmentTools(store));
});

const run = (name: string, args: unknown) => registry.execute(name, JSON.stringify(args));

describe("appointment tools", () => {
  it("lists free slots for a date and resource", async () => {
    const result = await run("list_available_slots", { date: DATE, resource: "room-a" });
    expect(result).toEqual({
      slots: [
        { slotId: "room-a-2026-11-02T09", start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z", resource: "room-a" },
        { slotId: "room-a-2026-11-02T10", start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z", resource: "room-a" },
      ],
    });
    expect(await run("list_available_slots", { date: "2026-11-03" })).toEqual({ slots: [] });
  });

  it("books a slot and hides it from the free list", async () => {
    expect(await run("book_slot", { slotId: "room-a-2026-11-02T09", name: "Alex", contact: "alex@example.com" })).toEqual({
      ok: true,
      bookingId: "bk_1",
    });
    const result = (await run("list_available_slots", { date: DATE })) as { slots: { slotId: string }[] };
    expect(result.slots.map((s) => s.slotId)).not.toContain("room-a-2026-11-02T09");
    expect(result.slots).toHaveLength(3);
  });

  it("rejects a double booking with SLOT_TAKEN", async () => {
    const args = { slotId: "room-b-2026-11-02T10", name: "Alex", contact: "555-0100" };
    await run("book_slot", args);
    expect(await run("book_slot", { ...args, name: "Sam" })).toEqual({ ok: false, error: "SLOT_TAKEN" });
    expect(store.bookingCount).toBe(1);
  });

  it("returns NOT_FOUND for unknown slots and bookings", async () => {
    expect(await run("book_slot", { slotId: "nope", name: "Alex", contact: "555-0100" })).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    expect(await run("cancel_booking", { bookingId: "bk_99" })).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("cancels a booking and frees the slot again", async () => {
    await run("book_slot", { slotId: "room-a-2026-11-02T09", name: "Alex", contact: "555-0100" });
    expect(await run("cancel_booking", { bookingId: "bk_1" })).toEqual({ ok: true });
    const result = (await run("list_available_slots", { date: DATE })) as { slots: unknown[] };
    expect(result.slots).toHaveLength(4);
  });

  it("returns VALIDATION_ERROR for bad arguments and leaves the store unchanged", async () => {
    const result = await run("book_slot", { slotId: "room-a-2026-11-02T09", name: "", contact: "x" });
    expect(result).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    const paths = (result as { issues: { path: string }[] }).issues.map((i) => i.path).sort();
    expect(paths).toEqual(["contact", "name"]);
    expect(store.bookingCount).toBe(0);

    expect(await run("list_available_slots", { date: "02/11/2026" })).toMatchObject({ error: "VALIDATION_ERROR" });
  });

  it("returns VALIDATION_ERROR for malformed JSON", async () => {
    expect(await registry.execute("book_slot", "{not json")).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
  });

  it("returns UNKNOWN_TOOL for names it does not know", async () => {
    expect(await run("delete_everything", {})).toEqual({ ok: false, error: "UNKNOWN_TOOL" });
  });

  it("exposes JSON Schema parameters without the $schema marker", () => {
    const specs = registry.specs();
    expect(specs.map((s) => s.name)).toEqual(["list_available_slots", "book_slot", "cancel_booking"]);
    const book = specs[1]!;
    expect(book.parameters).not.toHaveProperty("$schema");
    expect(book.parameters).toMatchObject({
      type: "object",
      required: ["slotId", "name", "contact"],
      properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
    });
  });
});

describe("ToolRegistry failure handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out slow handlers", async () => {
    vi.useFakeTimers();
    const slow = new ToolRegistry(
      [defineTool({ name: "slow", description: "", input: z.object({}), handler: () => new Promise(() => {}) })],
      3000,
    );
    const pending = slow.execute("slow", "{}");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ ok: false, error: "TOOL_TIMEOUT" });
  });

  it("turns handler exceptions into TOOL_FAILED", async () => {
    const broken = new ToolRegistry([
      defineTool({
        name: "broken",
        description: "",
        input: z.object({}),
        handler: async () => {
          throw new Error("boom");
        },
      }),
    ]);
    expect(await broken.execute("broken", "")).toEqual({ ok: false, error: "TOOL_FAILED" });
  });

  it("rejects duplicate tool names", () => {
    const t = defineTool({ name: "t", description: "", input: z.object({}), handler: async () => null });
    expect(() => new ToolRegistry([t, t])).toThrow(/duplicate/);
  });
});
