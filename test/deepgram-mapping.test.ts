import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepgramAgentProvider } from "../src/provider/deepgram-agent.js";
import type { ProviderEvent, ToolSpec } from "../src/provider/types.js";
import { fakeSocketFactory, memoryLogger } from "./helpers.js";

const KEY = "dg-test-not-a-real-key-456";
const tools: ToolSpec[] = [
  { name: "list_available_slots", description: "List", parameters: { type: "object", properties: {} } },
];

async function connected() {
  const { factory, sockets } = fakeSocketFactory();
  const { logger, lines } = memoryLogger();
  const provider = new DeepgramAgentProvider({ apiKey: KEY, logger, socketFactory: factory });
  const events: ProviderEvent[] = [];
  provider.on((e) => events.push(e));
  const pending = provider.connect({ instructions: "Be brief.", tools, signal: new AbortController().signal });
  const socket = sockets[0]!;
  socket.open();
  socket.serverSendsJson({ type: "Welcome", request_id: "req-1" });
  socket.serverSendsJson({ type: "SettingsApplied" });
  await pending;
  return { provider, socket, events, lines };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DeepgramAgentProvider", () => {
  it("connects to the converse endpoint with a Token key", async () => {
    const { socket } = await connected();
    expect(socket.url).toBe("wss://agent.deepgram.com/v1/agent/converse");
    expect(socket.headers).toEqual({ Authorization: `Token ${KEY}` });
  });

  it("sends Settings after Welcome with linear16 24 kHz audio and client-side functions", async () => {
    const { socket } = await connected();
    expect(socket.jsonFrames()[0]).toEqual({
      type: "Settings",
      audio: {
        input: { encoding: "linear16", sample_rate: 24000 },
        output: { encoding: "linear16", sample_rate: 24000, container: "none" },
      },
      agent: {
        listen: { provider: { type: "deepgram", version: "v1", model: "nova-3" } },
        think: {
          provider: { type: "open_ai", version: "v1", model: "gpt-4o-mini" },
          prompt: "Be brief.",
          functions: [{ name: "list_available_slots", description: "List", parameters: { type: "object", properties: {} } }],
        },
        speak: { provider: { type: "deepgram", version: "v1", model: "aura-2-thalia-en" } },
      },
    });
  });

  it("does not resolve connect before SettingsApplied", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const { logger } = memoryLogger();
    const provider = new DeepgramAgentProvider({ apiKey: KEY, logger, socketFactory: factory });
    let resolved = false;
    void provider.connect({ instructions: "", tools: [], signal: new AbortController().signal }).then(() => (resolved = true));
    sockets[0]!.open();
    sockets[0]!.serverSendsJson({ type: "Welcome", request_id: "r" });
    await Promise.resolve();
    expect(resolved).toBe(false);
    sockets[0]!.serverSendsJson({ type: "SettingsApplied" });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("maps binary audio, ConversationText and client-side FunctionCallRequest", async () => {
    const { socket, events } = await connected();
    events.length = 0;
    const pcm = Buffer.from([5, 6]);
    socket.serverSendsBinary(pcm);
    socket.serverSendsJson({ type: "ConversationText", role: "user", content: "any slots?" });
    socket.serverSendsJson({ type: "ConversationText", role: "assistant", content: "Let me check." });
    socket.serverSendsJson({
      type: "FunctionCallRequest",
      functions: [
        { id: "fc_1", name: "list_available_slots", arguments: '{"date":"2026-11-02"}', client_side: true },
        { id: "fc_2", name: "server_thing", arguments: "{}", client_side: false },
      ],
    });
    socket.serverSendsJson({ type: "AgentAudioDone" });

    expect(events).toEqual([
      { type: "audio", chunk: { pcm16: pcm, sampleRate: 24000 } },
      { type: "transcript", role: "user", text: "any slots?", final: true },
      { type: "transcript", role: "agent", text: "Let me check.", final: true },
      { type: "tool_call", callId: "fc_1", name: "list_available_slots", argumentsJson: '{"date":"2026-11-02"}' },
    ]);
  });

  it("sends audio as binary frames and tool results as FunctionCallResponse", async () => {
    const { provider, socket } = await connected();
    provider.sendAudio({ pcm16: Buffer.from([1, 1]), sampleRate: 24000 });
    provider.sendToolResult("fc_1", "list_available_slots", { slots: [] });
    expect(socket.binaryFrames()).toEqual([Buffer.from([1, 1])]);
    expect(socket.jsonFrames().at(-1)).toEqual({
      type: "FunctionCallResponse",
      id: "fc_1",
      name: "list_available_slots",
      content: '{"slots":[]}',
    });
  });

  it("does not answer a function call the server cancelled", async () => {
    const { provider, socket } = await connected();
    socket.serverSendsJson({ type: "FunctionCallCancelled", functions: [{ id: "fc_9", name: "list_available_slots" }] });
    const before = socket.sent.length;
    provider.sendToolResult("fc_9", "list_available_slots", { slots: [] });
    expect(socket.sent.length).toBe(before);
  });

  it("sends KeepAlive every 5 seconds and stops after close", async () => {
    vi.useFakeTimers();
    const { provider, socket } = await connected();
    const keepAlives = () => socket.jsonFrames().filter((f) => f.type === "KeepAlive").length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(keepAlives()).toBe(3);
    await provider.close();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(keepAlives()).toBe(3);
  });

  it("maps Error messages and rejects connect on an Error before SettingsApplied", async () => {
    const { socket, events } = await connected();
    socket.serverSendsJson({ type: "Error", code: "SOME_FAILURE", description: "it broke" });
    expect(events.at(-1)).toEqual({ type: "error", code: "SOME_FAILURE", message: "it broke", retryable: true });

    const { factory, sockets } = fakeSocketFactory();
    const { logger } = memoryLogger();
    const provider = new DeepgramAgentProvider({ apiKey: KEY, logger, socketFactory: factory });
    const pending = provider.connect({ instructions: "", tools: [], signal: new AbortController().signal });
    sockets[0]!.open();
    sockets[0]!.serverSendsJson({ type: "Welcome", request_id: "r" });
    sockets[0]!.serverSendsJson({ type: "Error", code: "INVALID_SETTINGS", description: "bad think provider" });
    await expect(pending).rejects.toMatchObject({ code: "INVALID_SETTINGS", retryable: false });
  });

  it("answers health checks from pong frames", async () => {
    const { provider, socket } = await connected();
    expect(await provider.healthCheck()).toBe(true);
    expect(socket.pings).toBe(1);
    socket.answerPings = false;
    const pending = provider.healthCheck();
    socket.close(1006, "");
    expect(await pending).toBe(false);
    expect(await provider.healthCheck()).toBe(false);
  });

  it("never writes the API key to the log", async () => {
    const { provider, socket, lines } = await connected();
    socket.serverSendsJson({ type: "Warning", code: "W1", description: "slow" });
    await provider.close();
    expect(lines.join("\n")).not.toContain(KEY);
  });
});
