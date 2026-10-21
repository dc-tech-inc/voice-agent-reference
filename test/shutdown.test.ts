import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviders, loadConfig } from "../src/config.js";
import { DeepgramAgentProvider } from "../src/provider/deepgram-agent.js";
import { FakeProvider } from "../src/provider/fake-provider.js";
import { OpenAIRealtimeProvider } from "../src/provider/openai-realtime.js";
import { CallSession } from "../src/session/call-session.js";
import { installGracefulShutdown } from "../src/shutdown.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { silentLogger } from "./helpers.js";

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
  exit = ((code?: number) => {
    this.exitCode = code;
  }) as unknown as NodeJS.Process["exit"];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installGracefulShutdown", () => {
  it("on SIGTERM ends the session, closes providers and exits 0", async () => {
    const provider = new FakeProvider("p");
    const session = new CallSession({ providers: [provider], tools: new ToolRegistry([]), instructions: "", logger: silentLogger });
    await session.start();
    const proc = new FakeProcess();
    installGracefulShutdown(session, silentLogger, { proc: proc as unknown as NodeJS.Process });

    proc.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(proc.exitCode).toBe(0));
    expect(session.state).toBe("ended");
    expect(provider.closeCalls).toBe(1);
  });

  it("exits 1 when hangup does not finish in time", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    installGracefulShutdown({ hangup: () => new Promise(() => {}) }, silentLogger, {
      proc: proc as unknown as NodeJS.Process,
      timeoutMs: 5000,
    });
    proc.emit("SIGINT", "SIGINT");
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.exitCode).toBe(1);
  });

  it("can be uninstalled", () => {
    const proc = new FakeProcess();
    const uninstall = installGracefulShutdown({ hangup: async () => {} }, silentLogger, {
      proc: proc as unknown as NodeJS.Process,
    });
    expect(proc.listenerCount("SIGINT")).toBe(1);
    uninstall();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("config", () => {
  it("applies defaults and treats empty keys as unset", () => {
    const config = loadConfig({ OPENAI_API_KEY: "", DEEPGRAM_API_KEY: "  " });
    expect(config).toEqual({
      OPENAI_API_KEY: undefined,
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
      DEEPGRAM_API_KEY: undefined,
      LOG_LEVEL: "info",
    });
    expect(createProviders(config, silentLogger)).toEqual([]);
  });

  it("builds providers in failover order for the keys that are set", () => {
    const providers = createProviders(loadConfig({ OPENAI_API_KEY: "a", DEEPGRAM_API_KEY: "b" }), silentLogger);
    expect(providers[0]).toBeInstanceOf(OpenAIRealtimeProvider);
    expect(providers[1]).toBeInstanceOf(DeepgramAgentProvider);
  });

  it("names the invalid variable without echoing its value", () => {
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow("invalid environment: LOG_LEVEL");
  });
});
