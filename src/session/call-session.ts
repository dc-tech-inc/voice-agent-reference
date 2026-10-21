import type { Logger } from "../log.js";
import { SAMPLE_RATE, type AudioChunk, type ProviderEvent, type VoiceProvider } from "../provider/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { connectWithFailover, DEFAULT_POLICY, withTimeout, type FailoverPolicy } from "./failover.js";
import { transition, type SessionEvent, type SessionState } from "./state-machine.js";

export type SessionOutput =
  | { type: "state"; from: SessionState; to: SessionState; provider?: string; reason?: string }
  | { type: "transcript"; role: "user" | "agent"; text: string; final: boolean; provider: string }
  | { type: "audio"; chunk: AudioChunk; provider: string }
  | { type: "tool"; callId: string; name: string; result: unknown; provider: string };

export type CallSessionOptions = {
  providers: VoiceProvider[];
  tools: ToolRegistry;
  instructions: string;
  logger: Logger;
  policy?: Partial<FailoverPolicy>;
  /** Injectable for deterministic backoff in tests. */
  random?: () => number;
};

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/**
 * One call. Owns the ordered provider list, moves through the session state machine, fails over
 * between providers, buffers audio while no provider is active and dispatches tool calls.
 */
export class CallSession {
  private stateValue: SessionState = "idle";
  private readonly policy: FailoverPolicy;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private readonly disabled = new Set<number>();
  private readonly listeners = new Set<(o: SessionOutput) => void>();
  private current: { index: number; provider: VoiceProvider; unsubscribe: () => void } | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private healthCheckRunning = false;
  private failoverRunning: Promise<void> | undefined;
  private buffer: AudioChunk[] = [];
  private bufferedBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly opts: CallSessionOptions) {
    if (opts.providers.length === 0) throw new Error("at least one provider is required");
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.random = opts.random ?? Math.random;
    this.logger = opts.logger.child({ component: "call-session" });
  }

  get state(): SessionState {
    return this.stateValue;
  }

  get activeProvider(): string | undefined {
    return this.stateValue === "active" ? this.current?.provider.name : undefined;
  }

  on(listener: (o: SessionOutput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connects to the first provider that becomes ready. Resolves with the resulting state ("active" or "ended"). */
  async start(): Promise<SessionState> {
    this.apply({ type: "start" });
    await this.runFailover(this.opts.providers.map((_, i) => i));
    return this.stateValue;
  }

  /** Caller audio. Forwarded when active, buffered (bounded) while connecting or degraded, ignored after the call ended. */
  sendAudio(chunk: AudioChunk): void {
    if (this.stateValue === "active" && this.current) {
      this.current.provider.sendAudio(chunk);
      return;
    }
    if (this.stateValue === "ended" || this.stateValue === "idle") return;
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.pcm16.length;
    const limit = this.policy.audioBufferMs * BYTES_PER_MS;
    while (this.bufferedBytes > limit && this.buffer.length > 0) {
      const dropped = this.buffer.shift()!;
      this.bufferedBytes -= dropped.pcm16.length;
      this.droppedBytes += dropped.pcm16.length;
    }
  }

  async hangup(reason = "caller hung up"): Promise<void> {
    if (this.stateValue === "ended") return;
    this.abort.abort();
    this.apply({ type: "hangup", reason });
    await this.teardown();
  }

  // --- internals ----------------------------------------------------------

  private apply(event: SessionEvent): void {
    const from = this.stateValue;
    const to = transition(from, event);
    this.stateValue = to;
    const provider = "provider" in event ? event.provider : undefined;
    const reason = "reason" in event ? event.reason : undefined;
    this.logger.info({ from, to, event: event.type, provider, reason }, "state change");
    this.emit({ type: "state", from, to, ...(provider && { provider }), ...(reason && { reason }) });
  }

  private emit(output: SessionOutput): void {
    for (const listener of this.listeners) listener(output);
  }

  /** Called from `start()` and whenever the active provider fails. Never runs twice at once. */
  private runFailover(order: number[]): Promise<void> {
    if (this.failoverRunning) return this.failoverRunning;
    this.failoverRunning = (async () => {
      const index = await connectWithFailover({
        providers: this.opts.providers,
        order,
        disabled: this.disabled,
        cfg: { instructions: this.opts.instructions, tools: this.opts.tools.specs() },
        policy: this.policy,
        random: this.random,
        signal: this.abort.signal,
        onAttemptFailed: (provider, error, attempt) => {
          this.logger.warn({ provider: provider.name, code: error.code, attempt, retryable: error.retryable }, "connect failed");
          this.apply({ type: "provider_failed", provider: provider.name, reason: `${error.code}: ${error.message}` });
        },
      });
      if (this.stateValue === "ended") return;
      if (index === undefined) {
        this.apply({ type: "providers_exhausted" });
        await this.teardown();
        return;
      }
      this.attach(index);
    })().finally(() => {
      this.failoverRunning = undefined;
    });
    return this.failoverRunning;
  }

  private attach(index: number): void {
    const provider = this.opts.providers[index]!;
    const unsubscribe = provider.on((e) => this.onProviderEvent(provider, e));
    this.current = { index, provider, unsubscribe };
    this.apply({ type: "provider_ready", provider: provider.name });
    this.flushBuffer(provider);
    this.startHealthChecks();
  }

  private async detachCurrent(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    current.unsubscribe();
    await withTimeout(current.provider.close(), 2000, undefined);
  }

  private flushBuffer(provider: VoiceProvider): void {
    if (this.droppedBytes > 0) {
      this.logger.warn({ droppedMs: Math.round(this.droppedBytes / BYTES_PER_MS) }, "dropped caller audio while degraded");
    }
    for (const chunk of this.buffer) provider.sendAudio(chunk);
    this.buffer = [];
    this.bufferedBytes = 0;
    this.droppedBytes = 0;
  }

  private startHealthChecks(): void {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.checkHealth(), this.policy.healthIntervalMs);
  }

  private async checkHealth(): Promise<void> {
    const current = this.current;
    if (!current || this.stateValue !== "active" || this.healthCheckRunning) return;
    this.healthCheckRunning = true;
    try {
      const healthy = await withTimeout(current.provider.healthCheck(), this.policy.healthTimeoutMs, false);
      if (!healthy && this.current === current) await this.failActive(current.provider, "health check failed", true);
    } finally {
      this.healthCheckRunning = false;
    }
  }

  private onProviderEvent(provider: VoiceProvider, event: ProviderEvent): void {
    if (this.current?.provider !== provider) return;
    switch (event.type) {
      case "audio":
        this.emit({ type: "audio", chunk: event.chunk, provider: provider.name });
        return;
      case "transcript":
        this.emit({ type: "transcript", role: event.role, text: event.text, final: event.final, provider: provider.name });
        return;
      case "tool_call":
        void this.dispatchTool(provider, event.callId, event.name, event.argumentsJson);
        return;
      case "error":
        // Every provider error is treated as fatal for this connection (see README, limitations).
        void this.failActive(provider, `${event.code}: ${event.message}`, event.retryable);
        return;
      case "closed":
        void this.failActive(provider, event.reason, true);
        return;
      case "ready":
        return;
    }
  }

  private async failActive(provider: VoiceProvider, reason: string, retryable: boolean): Promise<void> {
    const current = this.current;
    if (!current || current.provider !== provider || this.stateValue !== "active") return;
    if (!retryable) this.disabled.add(current.index);
    clearInterval(this.healthTimer);
    this.apply({ type: "provider_failed", provider: provider.name, reason });
    await this.detachCurrent();
    // Try the other providers first; the one that just failed goes last.
    const n = this.opts.providers.length;
    const order = Array.from({ length: n }, (_, i) => (current.index + 1 + i) % n);
    await this.runFailover(order);
  }

  private async dispatchTool(provider: VoiceProvider, callId: string, name: string, argumentsJson: string): Promise<void> {
    // `current` is a new object on every attach, so this identifies the connection, not just the
    // provider: a reconnect to the same provider must not receive a result for a call it never made.
    const connection = this.current;
    const result = await this.opts.tools.execute(name, argumentsJson);
    if (this.current !== connection || this.stateValue !== "active") {
      this.logger.warn({ provider: provider.name, tool: name, callId }, "dropping tool result: connection no longer active");
      return;
    }
    this.logger.info({ provider: provider.name, tool: name, callId }, "tool call completed");
    provider.sendToolResult(callId, name, result);
    this.emit({ type: "tool", callId, name, result, provider: provider.name });
  }

  private async teardown(): Promise<void> {
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.buffer = [];
    this.bufferedBytes = 0;
    await this.detachCurrent();
  }
}
