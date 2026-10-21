import {
  ProviderError,
  type AudioChunk,
  type ConnectConfig,
  type ProviderEvent,
  type ProviderListener,
  type ToolSpec,
  type VoiceProvider,
} from "./types.js";

/** What one `connect()` attempt does. */
export type FakeConnectOutcome = "ok" | "fail" | "hang" | "reject_auth";

export type FakeProviderOptions = {
  /** One entry per connect attempt; the last entry repeats. Default: ["ok"]. */
  connectPlan?: FakeConnectOutcome[];
};

/**
 * Deterministic, scriptable provider for tests and the offline demo. It speaks no audio and calls
 * no network: the test or demo script plays the model's side with `userSays`, `agentSays`,
 * `callTool`, `crash` and `fail`.
 */
export class FakeProvider implements VoiceProvider {
  connectAttempts = 0;
  closeCalls = 0;
  healthy = true;
  tools: ToolSpec[] = [];
  readonly audioReceived: AudioChunk[] = [];
  readonly toolResults: { callId: string; name: string; output: unknown }[] = [];
  private connected = false;
  private readonly listeners = new Set<ProviderListener>();
  private readonly toolResultWaiters: ((r: { callId: string; name: string; output: unknown }) => void)[] = [];
  private readonly plan: FakeConnectOutcome[];

  constructor(
    readonly name: string,
    opts: FakeProviderOptions = {},
  ) {
    this.plan = opts.connectPlan?.length ? opts.connectPlan : ["ok"];
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(cfg: ConnectConfig): Promise<void> {
    const outcome = this.plan[Math.min(this.connectAttempts, this.plan.length - 1)]!;
    this.connectAttempts++;
    this.tools = cfg.tools;
    switch (outcome) {
      case "ok":
        this.connected = true;
        this.emit({ type: "ready" });
        return;
      case "fail":
        throw new ProviderError("FAKE_CONNECT_FAILED", `${this.name}: connect failed`, true);
      case "reject_auth":
        throw new ProviderError("FAKE_AUTH_REJECTED", `${this.name}: credentials rejected`, false);
      case "hang":
        return new Promise<void>((_resolve, reject) => {
          cfg.signal.addEventListener("abort", () => reject(new ProviderError("CONNECT_ABORTED", "aborted", true)), {
            once: true,
          });
        });
    }
  }

  sendAudio(chunk: AudioChunk): void {
    if (this.connected) this.audioReceived.push(chunk);
  }

  sendToolResult(callId: string, name: string, output: unknown): void {
    const result = { callId, name, output };
    this.toolResults.push(result);
    for (const resolve of this.toolResultWaiters.splice(0)) resolve(result);
  }

  async healthCheck(): Promise<boolean> {
    return this.connected && this.healthy;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.connected = false;
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- script API ---------------------------------------------------------

  userSays(text: string): void {
    this.emit({ type: "transcript", role: "user", text, final: true });
  }

  agentSays(text: string): void {
    this.emit({ type: "transcript", role: "agent", text, final: true });
    this.emit({ type: "audio", chunk: { pcm16: Buffer.alloc(480), sampleRate: 24000 } });
  }

  callTool(name: string, args: unknown, callId = `call_${this.toolResults.length + 1}`): void {
    this.emit({ type: "tool_call", callId, name, argumentsJson: JSON.stringify(args) });
  }

  /** Resolves with the next tool result the session sends back. */
  nextToolResult(): Promise<{ callId: string; name: string; output: unknown }> {
    return new Promise((resolve) => this.toolResultWaiters.push(resolve));
  }

  crash(reason = "connection lost"): void {
    this.connected = false;
    this.emit({ type: "closed", reason });
  }

  fail(code: string, message: string, retryable = true): void {
    this.emit({ type: "error", code, message, retryable });
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
