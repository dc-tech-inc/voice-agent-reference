import { ProviderError, SAMPLE_RATE, type AudioChunk, type ConnectConfig } from "./types.js";
import { WsProvider, type WsProviderOptions } from "./ws.js";

export type DeepgramAgentOptions = WsProviderOptions & {
  apiKey: string;
  listenModel?: string;
  thinkProvider?: { type: string; version?: string; model: string };
  speakModel?: string;
  keepAliveMs?: number;
};

type FunctionCall = { id?: unknown; name?: unknown; arguments?: unknown; client_side?: unknown };

const NOT_RETRYABLE = /auth|forbidden|unauthori[sz]ed|invalid.?settings/i;

/**
 * Deepgram Voice Agent API over a server-side WebSocket.
 * Docs: https://developers.deepgram.com/reference/voice-agent/voice-agent.md
 *       https://developers.deepgram.com/docs/build-a-voice-agent-javascript.md
 * Untested against the live API: the protocol mapping is covered by unit tests with a fake socket.
 */
export class DeepgramAgentProvider extends WsProvider {
  readonly name = "deepgram-agent";
  private keepAlive: NodeJS.Timeout | undefined;
  private config: ConnectConfig | undefined;
  private readonly cancelled = new Set<string>();

  constructor(private readonly opts: DeepgramAgentOptions) {
    super(opts);
  }

  protected url(): string {
    return "wss://agent.deepgram.com/v1/agent/converse";
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Token ${this.opts.apiKey}` };
  }

  protected handleOpen(cfg: ConnectConfig): void {
    // Settings are sent after the server's Welcome message, as in Deepgram's JavaScript guide.
    this.config = cfg;
    this.cancelled.clear();
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => this.send({ type: "KeepAlive" }), this.opts.keepAliveMs ?? 5000);
  }

  protected handleClosed(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }

  private settings(cfg: ConnectConfig): Record<string, unknown> {
    return {
      type: "Settings",
      audio: {
        input: { encoding: "linear16", sample_rate: SAMPLE_RATE },
        output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
      },
      agent: {
        listen: { provider: { type: "deepgram", version: "v1", model: this.opts.listenModel ?? "nova-3" } },
        think: {
          provider: this.opts.thinkProvider ?? { type: "open_ai", version: "v1", model: "gpt-4o-mini" },
          prompt: cfg.instructions,
          // No `endpoint`: the functions run client-side, in this process.
          functions: cfg.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        },
        speak: { provider: { type: "deepgram", version: "v1", model: this.opts.speakModel ?? "aura-2-thalia-en" } },
      },
    };
  }

  protected handleText(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "Welcome":
        if (this.config) this.send(this.settings(this.config));
        return;
      case "SettingsApplied":
        this.markReady();
        return;
      case "ConversationText":
        this.emit({
          type: "transcript",
          role: msg.role === "user" ? "user" : "agent",
          text: String(msg.content ?? ""),
          final: true,
        });
        return;
      case "FunctionCallRequest":
        for (const fn of (Array.isArray(msg.functions) ? msg.functions : []) as FunctionCall[]) {
          // Server-side functions are executed by Deepgram itself; only client-side ones are ours.
          if (fn.client_side !== true) continue;
          this.emit({
            type: "tool_call",
            callId: String(fn.id),
            name: String(fn.name),
            argumentsJson: typeof fn.arguments === "string" ? fn.arguments : "",
          });
        }
        return;
      case "FunctionCallCancelled":
        for (const fn of (Array.isArray(msg.functions) ? msg.functions : []) as FunctionCall[]) {
          this.cancelled.add(String(fn.id));
        }
        return;
      case "Error": {
        const code = String(msg.code ?? "unknown_error");
        const message = String(msg.description ?? "provider error");
        const retryable = !NOT_RETRYABLE.test(`${code} ${message}`);
        if (!this.failConnect(new ProviderError(code, message, retryable))) {
          this.emit({ type: "error", code, message, retryable });
        }
        return;
      }
      case "Warning":
        this.logger.warn({ provider: this.name, code: msg.code, description: msg.description }, "provider warning");
        return;
      default:
        // UserStartedSpeaking, AgentThinking, AgentStartedSpeaking, AgentAudioDone, History, ...
        this.logger.trace({ provider: this.name, event: msg.type }, "ignored event");
    }
  }

  protected handleBinary(data: Buffer): void {
    this.emit({ type: "audio", chunk: { pcm16: data, sampleRate: SAMPLE_RATE } });
  }

  sendAudio(chunk: AudioChunk): void {
    this.send(chunk.pcm16);
  }

  sendToolResult(callId: string, name: string, output: unknown): void {
    if (this.cancelled.delete(callId)) {
      this.logger.info({ provider: this.name, callId }, "not answering cancelled function call");
      return;
    }
    this.send({ type: "FunctionCallResponse", id: callId, name, content: JSON.stringify(output) });
  }
}
