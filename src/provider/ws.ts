import { WebSocket } from "ws";
import type { Logger } from "../log.js";
import {
  ProviderError,
  type AudioChunk,
  type ConnectConfig,
  type ProviderEvent,
  type ProviderListener,
  type VoiceProvider,
} from "./types.js";

/** The subset of the `ws` client the adapters use. Tests pass a fake that implements it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | Buffer): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  on(event: "pong", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export const OPEN = 1;

export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => new WebSocket(url, { headers });

export type WsProviderOptions = { logger: Logger; socketFactory?: WebSocketFactory };

/**
 * Shared plumbing for WebSocket providers: connect/abort, listener fan-out, ping/pong health check.
 * Subclasses translate provider frames to `ProviderEvent`s and call `markReady()` once the
 * provider has accepted the session configuration.
 */
export abstract class WsProvider implements VoiceProvider {
  abstract readonly name: string;
  protected socket: WebSocketLike | undefined;
  protected readonly logger: Logger;
  private readonly socketFactory: WebSocketFactory;
  private readonly listeners = new Set<ProviderListener>();
  private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | undefined;
  private pongWaiters: ((alive: boolean) => void)[] = [];

  constructor(opts: WsProviderOptions) {
    this.logger = opts.logger;
    this.socketFactory = opts.socketFactory ?? defaultWebSocketFactory;
  }

  protected abstract url(): string;
  /** Auth headers. Never logged. */
  protected abstract headers(): Record<string, string>;
  protected abstract handleOpen(cfg: ConnectConfig): void;
  protected abstract handleText(message: Record<string, unknown>): void;
  protected abstract handleBinary(data: Buffer): void;
  abstract sendAudio(chunk: AudioChunk): void;
  abstract sendToolResult(callId: string, name: string, output: unknown): void;
  /** Called when the socket closes, for subclass cleanup (timers). */
  protected handleClosed(): void {}

  connect(cfg: ConnectConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (cfg.signal.aborted) {
        reject(new ProviderError("CONNECT_ABORTED", "connect aborted", true));
        return;
      }
      this.pendingConnect = { resolve, reject };
      this.logger.debug({ provider: this.name, url: this.url() }, "connecting");
      const ws = this.socketFactory(this.url(), this.headers());
      this.socket = ws;

      cfg.signal.addEventListener(
        "abort",
        () => {
          this.failConnect(new ProviderError("CONNECT_ABORTED", "connect aborted", true));
          ws.close();
        },
        { once: true },
      );

      ws.on("open", () => this.handleOpen(cfg));
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          this.handleBinary(data);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString("utf8"));
        } catch {
          this.logger.warn({ provider: this.name }, "ignoring non-JSON text frame");
          return;
        }
        if (parsed && typeof parsed === "object") this.handleText(parsed as Record<string, unknown>);
      });
      ws.on("pong", () => this.resolvePongs(true));
      ws.on("error", (err) => {
        // The handshake failing (DNS, TLS, HTTP 401/403) surfaces here before "open".
        if (this.failConnect(new ProviderError("SOCKET_ERROR", err.message, !/\b40[13]\b/.test(err.message)))) return;
        this.emit({ type: "error", code: "SOCKET_ERROR", message: err.message, retryable: true });
      });
      ws.on("close", (code, reason) => {
        this.handleClosed();
        this.resolvePongs(false);
        const text = `socket closed (${code}${reason.length ? `: ${reason.toString("utf8")}` : ""})`;
        if (this.failConnect(new ProviderError("CLOSED_DURING_CONNECT", text, true))) return;
        this.emit({ type: "closed", reason: text });
      });
    });
  }

  healthCheck(): Promise<boolean> {
    const ws = this.socket;
    if (!ws || ws.readyState !== OPEN) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pongWaiters.push(resolve);
      ws.ping();
    });
  }

  async close(): Promise<void> {
    const ws = this.socket;
    this.socket = undefined;
    this.handleClosed();
    this.resolvePongs(false);
    if (ws && ws.readyState === OPEN) ws.close(1000, "session ended");
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  protected send(frame: Record<string, unknown> | Buffer): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== OPEN) {
      this.logger.warn({ provider: this.name }, "dropping outbound frame: socket not open");
      return;
    }
    ws.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
  }

  /** Call when the provider confirms the session configuration. */
  protected markReady(): void {
    const pending = this.pendingConnect;
    this.pendingConnect = undefined;
    pending?.resolve();
    this.emit({ type: "ready" });
  }

  /** Rejects the pending connect, if any. Returns true when there was one. */
  protected failConnect(err: ProviderError): boolean {
    const pending = this.pendingConnect;
    if (!pending) return false;
    this.pendingConnect = undefined;
    pending.reject(err);
    return true;
  }

  private resolvePongs(alive: boolean): void {
    const waiters = this.pongWaiters;
    this.pongWaiters = [];
    for (const w of waiters) w(alive);
  }
}
