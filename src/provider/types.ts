export const SAMPLE_RATE = 24000;

/** 16-bit little-endian mono PCM at 24 kHz. Both real providers accept this format. */
export type AudioChunk = { pcm16: Buffer; sampleRate: typeof SAMPLE_RATE };

/** Provider-neutral tool description. `parameters` is a JSON Schema object. */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ProviderEvent =
  | { type: "ready" }
  | { type: "audio"; chunk: AudioChunk }
  | { type: "transcript"; role: "user" | "agent"; text: string; final: boolean }
  | { type: "tool_call"; callId: string; name: string; argumentsJson: string }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "closed"; reason: string };

export type ProviderListener = (event: ProviderEvent) => void;

export type ConnectConfig = { instructions: string; tools: ToolSpec[]; signal: AbortSignal };

export interface VoiceProvider {
  readonly name: string;
  /** Resolves once the provider has accepted the session configuration. Rejects on failure or abort. */
  connect(cfg: ConnectConfig): Promise<void>;
  sendAudio(chunk: AudioChunk): void;
  sendToolResult(callId: string, name: string, output: unknown): void;
  /** True when the connection is alive (for socket providers: a pong came back). */
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
  /** Subscribe to events. Returns an unsubscribe function. */
  on(listener: ProviderListener): () => void;
}

/**
 * Error raised by `connect()`. `retryable: false` means retrying the same provider is pointless
 * (rejected key, rejected configuration), so the session moves straight to the next provider.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
