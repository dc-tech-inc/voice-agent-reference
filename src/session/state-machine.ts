export type SessionState = "idle" | "connecting" | "active" | "degraded" | "ended";

export type SessionEvent =
  | { type: "start" }
  | { type: "provider_ready"; provider: string }
  | { type: "provider_failed"; provider: string; reason: string }
  | { type: "providers_exhausted" }
  | { type: "hangup"; reason: string };

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly event: SessionEvent["type"],
  ) {
    super(`invalid transition: ${from} --${event}-->`);
    this.name = "InvalidTransitionError";
  }
}

// Pure transition table. Anything not listed here is a bug in the caller and throws.
const table: Record<SessionState, Partial<Record<SessionEvent["type"], SessionState>>> = {
  idle: { start: "connecting", hangup: "ended" },
  connecting: { provider_ready: "active", provider_failed: "degraded", hangup: "ended" },
  active: { provider_failed: "degraded", hangup: "ended" },
  // A retry that fails while already degraded keeps the session degraded.
  degraded: {
    provider_ready: "active",
    provider_failed: "degraded",
    providers_exhausted: "ended",
    hangup: "ended",
  },
  ended: {},
};

export function transition(state: SessionState, event: SessionEvent): SessionState {
  const next = table[state][event.type];
  if (!next) throw new InvalidTransitionError(state, event.type);
  return next;
}
