import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createLogger } from "../src/log.js";
import type { WebSocketFactory, WebSocketLike } from "../src/provider/ws.js";

/** In-process stand-in for a `ws` client. Tests drive the server side with `serverSends*`. */
export class FakeSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: (string | Buffer)[] = [];
  pings = 0;
  answerPings = true;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
  }

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings++;
    if (this.answerPings) queueMicrotask(() => this.emit("pong"));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  serverSendsJson(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  serverSendsBinary(data: Buffer): void {
    this.emit("message", data, true);
  }

  /** Outbound JSON frames, parsed. */
  jsonFrames(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }

  binaryFrames(): Buffer[] {
    return this.sent.filter((d): d is Buffer => Buffer.isBuffer(d));
  }
}

export function fakeSocketFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  };
}

/** Logger that keeps every line in memory, so tests can assert on what was (not) logged. */
export function memoryLogger(level = "trace") {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger(level, stream), lines };
}

export const silentLogger = createLogger("silent");
