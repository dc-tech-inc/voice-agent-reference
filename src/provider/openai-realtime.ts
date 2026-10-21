import { ProviderError, SAMPLE_RATE, type AudioChunk, type ConnectConfig } from "./types.js";
import { WsProvider, type WsProviderOptions } from "./ws.js";

export type OpenAIRealtimeOptions = WsProviderOptions & {
  apiKey: string;
  /** Model query parameter, e.g. "gpt-realtime-2.1". */
  model: string;
  voice?: string;
};

const NOT_RETRYABLE = /auth|permission|invalid_api_key|insufficient_quota/i;

/**
 * OpenAI Realtime API (GA) over a server-side WebSocket.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-websocket
 *       https://developers.openai.com/api/reference/resources/realtime/server-events
 * Untested against the live API: the protocol mapping is covered by unit tests with a fake socket.
 */
export class OpenAIRealtimeProvider extends WsProvider {
  readonly name = "openai-realtime";
  private ready = false;

  constructor(private readonly opts: OpenAIRealtimeOptions) {
    super(opts);
  }

  protected url(): string {
    return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.opts.model)}`;
  }

  protected headers(): Record<string, string> {
    // GA interface: no OpenAI-Beta header.
    return { Authorization: `Bearer ${this.opts.apiKey}` };
  }

  protected handleOpen(cfg: ConnectConfig): void {
    this.ready = false;
    const format = { type: "audio/pcm", rate: SAMPLE_RATE };
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: cfg.instructions,
        audio: {
          input: { format, turn_detection: { type: "semantic_vad" } },
          output: { format, voice: this.opts.voice ?? "marin" },
        },
        tools: cfg.tools.map((t) => ({ type: "function", ...t })),
        tool_choice: "auto",
      },
    });
  }

  protected handleText(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          this.markReady();
        }
        return;
      case "response.output_audio.delta":
        if (typeof msg.delta === "string") {
          this.emit({ type: "audio", chunk: { pcm16: Buffer.from(msg.delta, "base64"), sampleRate: SAMPLE_RATE } });
        }
        return;
      case "response.output_audio_transcript.delta":
        this.emit({ type: "transcript", role: "agent", text: String(msg.delta ?? ""), final: false });
        return;
      case "response.output_audio_transcript.done":
        this.emit({ type: "transcript", role: "agent", text: String(msg.transcript ?? ""), final: true });
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.emit({ type: "transcript", role: "user", text: String(msg.delta ?? ""), final: false });
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.emit({ type: "transcript", role: "user", text: String(msg.transcript ?? ""), final: true });
        return;
      case "response.function_call_arguments.done":
        this.emit({
          type: "tool_call",
          callId: String(msg.call_id),
          name: String(msg.name),
          argumentsJson: typeof msg.arguments === "string" ? msg.arguments : "",
        });
        return;
      case "error": {
        const err = (msg.error ?? {}) as { type?: string; code?: string; message?: string };
        const code = err.code ?? err.type ?? "unknown_error";
        const retryable = !NOT_RETRYABLE.test(`${err.type ?? ""} ${err.code ?? ""}`);
        const message = err.message ?? "provider error";
        if (!this.failConnect(new ProviderError(code, message, retryable))) {
          this.emit({ type: "error", code, message, retryable });
        }
        return;
      }
      default:
        // session.created, response.created, rate_limits.updated, ... are not needed by the session.
        this.logger.trace({ provider: this.name, event: msg.type }, "ignored event");
    }
  }

  protected handleBinary(): void {
    this.logger.warn({ provider: this.name }, "ignoring unexpected binary frame");
  }

  sendAudio(chunk: AudioChunk): void {
    this.send({ type: "input_audio_buffer.append", audio: chunk.pcm16.toString("base64") });
  }

  sendToolResult(callId: string, _name: string, output: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.send({ type: "response.create" });
  }
}
