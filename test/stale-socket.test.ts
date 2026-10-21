// Regression tests for Gate 2 must-fix 1: after a provider instance reconnects, events from its
// previous (replaced) socket must be ignored. With the real `ws` client, close() on an open socket
// does not emit "close" right away; the event arrives after the server answers or after
// `closeTimeout`, by which time the provider may already be on a new socket.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DeepgramAgentProvider } from "../src/provider/deepgram-agent.js";
import { OpenAIRealtimeProvider } from "../src/provider/openai-realtime.js";
import type { ProviderEvent } from "../src/provider/types.js";
import type { WebSocketFactory } from "../src/provider/ws.js";
import { CallSession } from "../src/session/call-session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { fakeSocketFactory, silentLogger } from "./helpers.js";

const cfg = () => ({ instructions: "x", tools: [], signal: new AbortController().signal });

describe("stale socket events (fake socket)", () => {
  it("a late close from the old socket neither rejects the new connect nor emits closed", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const provider = new OpenAIRealtimeProvider({ apiKey: "k", model: "m", logger: silentLogger, socketFactory: factory });
    const events: ProviderEvent[] = [];
    provider.on((e) => events.push(e));

    const first = provider.connect(cfg());
    sockets[0]!.open();
    sockets[0]!.serverSendsJson({ type: "session.updated" });
    await first;

    const second = provider.connect(cfg()); // same instance, new socket
    sockets[0]!.emit("close", 1006, Buffer.from("late")); // old socket's close arrives now
    sockets[0]!.emit("error", new Error("late error"));
    sockets[0]!.serverSendsJson({ type: "error", error: { type: "server_error", message: "stale" } });
    sockets[1]!.open();
    sockets[1]!.serverSendsJson({ type: "session.updated" });

    await expect(second).resolves.toBeUndefined();
    expect(events.filter((e) => e.type !== "ready")).toEqual([]);
  });

  it("a late close from the old socket does not stop the new socket's Deepgram KeepAlive", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const provider = new DeepgramAgentProvider({ apiKey: "k", logger: silentLogger, socketFactory: factory, keepAliveMs: 20 });
    for (const i of [0, 1]) {
      const pending = provider.connect(cfg());
      sockets[i]!.open();
      sockets[i]!.serverSendsJson({ type: "Welcome" });
      sockets[i]!.serverSendsJson({ type: "SettingsApplied" });
      await pending;
    }
    sockets[0]!.emit("close", 1006, Buffer.from(""));
    await new Promise((r) => setTimeout(r, 110));
    await provider.close();
    expect(sockets[1]!.jsonFrames().filter((f) => f.type === "KeepAlive").length).toBeGreaterThanOrEqual(3);
  });
});

// The same scenarios against a real `ws` server and client (scenarios from the Gate 2 review).
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(r));
  }
});

type Conn = { ws: WebSocket; frames: Record<string, unknown>[]; stall: () => void };

async function server(kind: "openai" | "deepgram") {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise((r) => wss.once("listening", r));
  const conns: Conn[] = [];
  wss.on("connection", (ws) => {
    const conn: Conn = {
      ws,
      frames: [],
      // Stop reading the TCP socket: pings and the close frame are never answered (a half-open link).
      stall: () => (ws as unknown as { _socket: { pause(): void } })._socket.pause(),
    };
    conns.push(conn);
    if (kind === "deepgram") ws.send(JSON.stringify({ type: "Welcome", request_id: `r${conns.length}` }));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      conn.frames.push(frame);
      if (frame.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: {} }));
      if (frame.type === "Settings") ws.send(JSON.stringify({ type: "SettingsApplied" }));
    });
  });
  const port = (wss.address() as AddressInfo).port;
  // Real ws client; only closeTimeout is shortened (default 30 s) to keep the test fast.
  // ws supports `closeTimeout` at runtime, but @types/ws 8.18 does not declare it.
  const factory: WebSocketFactory = (_url, headers) => {
    const options: WebSocket.ClientOptions & { closeTimeout: number } = { headers, closeTimeout: 800 };
    return new WebSocket(`ws://127.0.0.1:${port}`, options);
  };
  return { conns, factory };
}

describe("stale socket events (real ws)", () => {
  it("one mid-call error frame: the reconnect to the same provider succeeds first time", async () => {
    const { conns, factory } = await server("openai");
    const provider = new OpenAIRealtimeProvider({ apiKey: "k", model: "m", logger: silentLogger, socketFactory: factory });
    const session = new CallSession({ providers: [provider], tools: new ToolRegistry([]), instructions: "x", logger: silentLogger });
    const states: string[] = [];
    session.on((o) => o.type === "state" && states.push(`${o.to}${o.reason ? ` (${o.reason})` : ""}`));
    expect(await session.start()).toBe("active");

    conns[0]!.ws.send(JSON.stringify({ type: "error", error: { type: "server_error", code: "internal", message: "oops" } }));
    await wait(500);
    await session.hangup();
    expect(states).toEqual(["connecting", "active", "degraded (internal: oops)", "active", "ended (caller hung up)"]);
    expect(conns).toHaveLength(2);
  }, 10_000);

  it("a late close from a stalled socket does not fail over the healthy reconnected session", async () => {
    const { conns, factory } = await server("openai");
    const provider = new OpenAIRealtimeProvider({ apiKey: "k", model: "m", logger: silentLogger, socketFactory: factory });
    const session = new CallSession({
      providers: [provider],
      tools: new ToolRegistry([]),
      instructions: "x",
      logger: silentLogger,
      policy: { healthIntervalMs: 150, healthTimeoutMs: 150 },
    });
    const states: string[] = [];
    session.on((o) => o.type === "state" && states.push(o.to));

    expect(await session.start()).toBe("active");
    conns[0]!.stall();
    await wait(600); // health check fails -> reconnect on connection 2
    expect(conns).toHaveLength(2);
    expect(session.state).toBe("active");
    const before = states.length;

    await wait(1200); // connection 1's close handshake times out -> late "close" event
    await session.hangup();
    expect(states.slice(before)).toEqual(["ended"]);
    expect(conns).toHaveLength(2);
  }, 10_000);

  it("Deepgram: KeepAlive continues on the new socket after the old socket's late close", async () => {
    const { conns, factory } = await server("deepgram");
    const provider = new DeepgramAgentProvider({ apiKey: "k", logger: silentLogger, socketFactory: factory, keepAliveMs: 100 });
    const events: ProviderEvent[] = [];
    provider.on((e) => events.push(e));

    await provider.connect(cfg());
    conns[0]!.stall();
    await provider.close();
    await provider.connect(cfg());
    events.length = 0;

    await wait(1200); // old socket's close fires (closeTimeout 800 ms)
    const keepAlives = () => conns[1]!.frames.filter((f) => f.type === "KeepAlive").length;
    const before = keepAlives();
    await wait(600);
    const after = keepAlives();
    await provider.close();
    expect(events).toEqual([]);
    expect(after - before).toBeGreaterThanOrEqual(4);
  }, 10_000);

  it("OpenAI: a late close from the old socket does not reject a slow second connect", async () => {
    const { conns, factory } = await server("openai");
    const provider = new OpenAIRealtimeProvider({ apiKey: "k", model: "m", logger: silentLogger, socketFactory: factory });
    await provider.connect(cfg());
    conns[0]!.stall();
    await provider.close();

    const wss = servers[0]!;
    wss.removeAllListeners("connection");
    wss.on("connection", (ws) => {
      ws.on("message", () => setTimeout(() => ws.send(JSON.stringify({ type: "session.updated", session: {} })), 1500));
    });
    const result = await provider.connect(cfg()).then(
      () => "connected",
      (e: { code?: string }) => `rejected: ${e.code}`,
    );
    await provider.close();
    expect(result).toBe("connected");
  }, 10_000);
});
