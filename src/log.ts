import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

/** JSON logs to stdout (or `destination`). Secrets are never passed to the logger; `redact` is a second line of defence. */
export function createLogger(level = "info", destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "voice-agent-reference" },
      redact: ["headers.authorization", "headers.Authorization", "apiKey"],
    },
    destination,
  );
}
