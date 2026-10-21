import * as z from "zod";
import type { Logger } from "./log.js";
import { DeepgramAgentProvider } from "./provider/deepgram-agent.js";
import { OpenAIRealtimeProvider } from "./provider/openai-realtime.js";
import type { VoiceProvider } from "./provider/types.js";

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z.object({
  OPENAI_API_KEY: optionalSecret,
  OPENAI_REALTIME_MODEL: z.string().trim().min(1).default("gpt-realtime-2.1"),
  DEEPGRAM_API_KEY: optionalSecret,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

/** Validates the environment. Throws with the offending variable names (never their values). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid environment: ${names}`);
  }
  return parsed.data;
}

/** Real providers in failover order (OpenAI first, Deepgram second), for whichever keys are set. */
export function createProviders(config: Config, logger: Logger): VoiceProvider[] {
  const providers: VoiceProvider[] = [];
  if (config.OPENAI_API_KEY) {
    providers.push(new OpenAIRealtimeProvider({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_REALTIME_MODEL, logger }));
  }
  if (config.DEEPGRAM_API_KEY) {
    providers.push(new DeepgramAgentProvider({ apiKey: config.DEEPGRAM_API_KEY, logger }));
  }
  return providers;
}
