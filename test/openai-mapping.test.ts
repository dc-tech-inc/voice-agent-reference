import { describe, expect, it } from "vitest";
import { OpenAIRealtimeProvider } from "../src/provider/openai-realtime.js";
import { ProviderError, type ProviderEvent, type ToolSpec } from "../src/provider/types.js";
import { fakeSocketFactory, memoryLogger } from "./helpers.js";

const KEY = "sk-test-not-a-real-key-123";
const tools: ToolSpec[] = [
  { name: "book_slot", description: "Book", parameters: { type: "object", properties: {} } },
];

async function connected() {
  const { factory, sockets } = fakeSocketFactory();
  const { logger, lines } = memoryLogger();
  const provider = new OpenAIRealtimeProvider({ apiKey: KEY, model: "gpt-realtime-2.1", logger, socketFactory: factory });
  const events: ProviderEvent[] = [];
  provider.on((e) => events.push(e));
  const pending = provider.connect({ instructions: "Be brief.", tools, signal: new AbortController().signal });
  const socket = sockets[0]!;
  socket.open();
  socket.serverSendsJson({ type: "session.created", event_id: "e0", session: {} });
  socket.serverSendsJson({ type: "session.updated", event_id: "e1", session: {} });
  await pending;
  return { provider, socket, events, lines };
}

describe("OpenAIRealtimeProvider", () => {
  it("connects to the GA endpoint with a Bearer key and no beta header", async () => {
    const { socket } = await connected();
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1");
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("sends session.update with instructions, 24 kHz PCM and function tools", async () => {
    const { socket } = await connected();
    expect(socket.jsonFrames()[0]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "Be brief.",
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad" } },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
        tools: [{ type: "function", name: "book_slot", description: "Book", parameters: { type: "object", properties: {} } }],
        tool_choice: "auto",
      },
    });
  });

  it("emits ready once, on session.updated", async () => {
    const { socket, events } = await connected();
    socket.serverSendsJson({ type: "session.updated", event_id: "e2", session: {} });
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
  });

  it("maps audio, transcript and function-call server events", async () => {
    const { socket, events } = await connected();
    events.length = 0;
    const pcm = Buffer.from([1, 2, 3, 4]);
    socket.serverSendsJson({ type: "response.output_audio.delta", delta: pcm.toString("base64"), item_id: "i1" });
    socket.serverSendsJson({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    socket.serverSendsJson({ type: "response.output_audio_transcript.done", transcript: "Hello" });
    socket.serverSendsJson({ type: "conversation.item.input_audio_transcription.delta", delta: "boo" });
    socket.serverSendsJson({ type: "conversation.item.input_audio_transcription.completed", transcript: "book it" });
    socket.serverSendsJson({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "book_slot",
      arguments: '{"slotId":"a"}',
      item_id: "i2",
      output_index: 0,
      response_id: "r1",
    });
    socket.serverSendsJson({ type: "rate_limits.updated", rate_limits: [] });

    expect(events).toEqual([
      { type: "audio", chunk: { pcm16: pcm, sampleRate: 24000 } },
      { type: "transcript", role: "agent", text: "Hel", final: false },
      { type: "transcript", role: "agent", text: "Hello", final: true },
      { type: "transcript", role: "user", text: "boo", final: false },
      { type: "transcript", role: "user", text: "book it", final: true },
      { type: "tool_call", callId: "call_1", name: "book_slot", argumentsJson: '{"slotId":"a"}' },
    ]);
  });

  it("appends input audio as base64 and returns tool output followed by response.create", async () => {
    const { provider, socket } = await connected();
    provider.sendAudio({ pcm16: Buffer.from([9, 8]), sampleRate: 24000 });
    provider.sendToolResult("call_1", "book_slot", { ok: true, bookingId: "bk_1" });
    expect(socket.jsonFrames().slice(1)).toEqual([
      { type: "input_audio_buffer.append", audio: Buffer.from([9, 8]).toString("base64") },
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_1", output: '{"ok":true,"bookingId":"bk_1"}' },
      },
      { type: "response.create" },
    ]);
  });

  it("maps error events and classifies auth errors as not retryable", async () => {
    const { socket, events } = await connected();
    socket.serverSendsJson({ type: "error", error: { type: "server_error", code: "internal", message: "oops" } });
    socket.serverSendsJson({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key", message: "bad key" } });
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", code: "internal", message: "oops", retryable: true },
      { type: "error", code: "invalid_api_key", message: "bad key", retryable: false },
    ]);
  });

  it("rejects connect when the server answers session.update with an error", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const { logger } = memoryLogger();
    const provider = new OpenAIRealtimeProvider({ apiKey: KEY, model: "m", logger, socketFactory: factory });
    const pending = provider.connect({ instructions: "", tools: [], signal: new AbortController().signal });
    sockets[0]!.open();
    sockets[0]!.serverSendsJson({ type: "error", error: { type: "invalid_request_error", code: "bad_session", message: "no" } });
    await expect(pending).rejects.toMatchObject({ code: "bad_session", retryable: true });
  });

  it("rejects connect on a 401 handshake as not retryable", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const { logger } = memoryLogger();
    const provider = new OpenAIRealtimeProvider({ apiKey: KEY, model: "m", logger, socketFactory: factory });
    const pending = provider.connect({ instructions: "", tools: [], signal: new AbortController().signal });
    sockets[0]!.emit("error", new Error("Unexpected server response: 401"));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "SOCKET_ERROR", retryable: false });
  });

  it("rejects and closes the socket when the connect is aborted (timeout)", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const { logger } = memoryLogger();
    const provider = new OpenAIRealtimeProvider({ apiKey: KEY, model: "m", logger, socketFactory: factory });
    const ac = new AbortController();
    const pending = provider.connect({ instructions: "", tools: [], signal: ac.signal });
    sockets[0]!.open();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "CONNECT_ABORTED" });
    expect(sockets[0]!.readyState).toBe(3);
    await expect(provider.connect({ instructions: "", tools: [], signal: ac.signal })).rejects.toMatchObject({
      code: "CONNECT_ABORTED",
    });
  });

  it("drops outbound frames when the socket is not open", async () => {
    const { provider, socket } = await connected();
    await provider.close();
    const before = socket.sent.length;
    provider.sendAudio({ pcm16: Buffer.from([1]), sampleRate: 24000 });
    expect(socket.sent.length).toBe(before);
  });

  it("emits closed when the socket drops after ready", async () => {
    const { socket, events } = await connected();
    socket.close(1006, "gone");
    expect(events.at(-1)).toEqual({ type: "closed", reason: "socket closed (1006: gone)" });
  });

  it("never writes the API key to the log", async () => {
    const { provider, lines } = await connected();
    await provider.close();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(KEY);
  });
});
