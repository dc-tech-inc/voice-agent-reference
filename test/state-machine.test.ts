import { describe, expect, it } from "vitest";
import { InvalidTransitionError, transition, type SessionEvent, type SessionState } from "../src/session/state-machine.js";

const start: SessionEvent = { type: "start" };
const ready: SessionEvent = { type: "provider_ready", provider: "p" };
const failed: SessionEvent = { type: "provider_failed", provider: "p", reason: "x" };
const exhausted: SessionEvent = { type: "providers_exhausted" };
const hangup: SessionEvent = { type: "hangup", reason: "caller" };

describe("transition", () => {
  it.each<[SessionState, SessionEvent, SessionState]>([
    ["idle", start, "connecting"],
    ["connecting", ready, "active"],
    ["connecting", failed, "degraded"],
    ["active", failed, "degraded"],
    ["degraded", ready, "active"],
    ["degraded", failed, "degraded"],
    ["degraded", exhausted, "ended"],
    ["idle", hangup, "ended"],
    ["connecting", hangup, "ended"],
    ["active", hangup, "ended"],
    ["degraded", hangup, "ended"],
  ])("%s --%o--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it.each<[SessionState, SessionEvent]>([
    ["idle", ready],
    ["idle", failed],
    ["connecting", start],
    ["connecting", exhausted],
    ["active", start],
    ["active", ready],
    ["active", exhausted],
    ["ended", start],
    ["ended", ready],
    ["ended", hangup],
  ])("rejects %s --%o-->", (from, event) => {
    expect(() => transition(from, event)).toThrow(InvalidTransitionError);
  });
});
