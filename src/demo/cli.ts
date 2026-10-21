/**
 * Offline demo: one scripted call against two FakeProviders. No network, no API keys, no audio.
 * The script plays the caller and the model; everything in between (state machine, failover,
 * tool validation, the store) is the real code.
 *
 *   pnpm demo
 */
import { pino } from "pino";
import { FakeProvider } from "../provider/fake-provider.js";
import { CallSession, type SessionOutput } from "../session/call-session.js";
import type { SessionState } from "../session/state-machine.js";
import { installGracefulShutdown } from "../shutdown.js";
import { appointmentTools } from "../tools/appointment-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryStore, seedSlots, type Slot } from "../tools/store.js";

const DATE = "2026-11-02";
// Logs go to stderr so stdout stays a readable transcript. LOG_LEVEL=info shows them.
const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" }, pino.destination(2));

const store = new InMemoryStore(seedSlots([DATE], ["room-a", "room-b"], [9, 10, 11]));
const primary = new FakeProvider("fake-primary");
const fallback = new FakeProvider("fake-fallback");
const session = new CallSession({
  providers: [primary, fallback],
  tools: new ToolRegistry(appointmentTools(store)),
  instructions: "You are the voice assistant of a shared-room appointment desk. Keep answers short.",
  logger,
});

const short = (value: unknown) => {
  const json = JSON.stringify(value);
  return json.length > 110 ? `${json.slice(0, 107)}...` : json;
};

let audioChunks = 0;
session.on((o: SessionOutput) => {
  switch (o.type) {
    case "state":
      console.log(`  [state] ${o.from} -> ${o.to}${o.provider ? ` (${o.provider})` : ""}${o.reason ? `: ${o.reason}` : ""}`);
      break;
    case "transcript":
      console.log(`${o.role === "user" ? "caller" : "agent "} > ${o.text}`);
      break;
    case "tool":
      console.log(`  [tool ] ${o.name} -> ${short(o.result)}`);
      break;
    case "audio":
      audioChunks++;
      break;
  }
});

function waitForState(state: SessionState): Promise<void> {
  return new Promise((resolve) => {
    if (session.state === state) return resolve();
    const off = session.on((o) => {
      if (o.type === "state" && o.to === state) {
        off();
        resolve();
      }
    });
  });
}

async function callTool(provider: FakeProvider, name: string, args: unknown) {
  const result = provider.nextToolResult();
  provider.callTool(name, args);
  return (await result).output;
}

async function main(): Promise<void> {
  const uninstall = installGracefulShutdown(session, logger);

  if ((await session.start()) !== "active") throw new Error("demo: no provider became active");

  primary.userSays("Hi, is anything free in room A on November 2nd?");
  const { slots } = (await callTool(primary, "list_available_slots", { date: DATE, resource: "room-a" })) as {
    slots: Slot[];
  };
  primary.agentSays(`Room A has ${slots.length} free slots: ${slots.map((s) => s.start.slice(11, 16)).join(", ")} UTC.`);
  primary.userSays("Ten o'clock, please. I'm Alex, my number is 555-0100.");

  console.log("\n  -- simulating a dropped connection to the primary provider --\n");
  primary.crash("socket closed (1006)");
  await waitForState("active");

  fallback.userSays("Hello? Ten o'clock in room A for Alex, 555-0100.");
  // The model forgets the contact field first: the call is rejected before it reaches the store.
  await callTool(fallback, "book_slot", { slotId: `room-a-${DATE}T10`, name: "Alex" });
  const booking = (await callTool(fallback, "book_slot", { slotId: `room-a-${DATE}T10`, name: "Alex", contact: "555-0100" })) as {
    bookingId: string;
  };
  fallback.agentSays(`Sorry about that. You're booked for 10:00 in room A, reference ${booking.bookingId}.`);

  await session.hangup("caller hung up");
  uninstall();

  const remaining = (await store.listAvailable(DATE, "room-a")).length;
  console.log(`\nDone. bookings=${store.bookingCount}, free room-a slots left=${remaining}, agent audio chunks=${audioChunks}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
