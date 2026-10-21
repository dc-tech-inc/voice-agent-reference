import type { Logger } from "./log.js";
import { withTimeout } from "./session/failover.js";

type Process = Pick<NodeJS.Process, "once" | "off" | "exit">;

/**
 * On SIGINT/SIGTERM: hang up the session (stops audio, closes providers), flush logs and exit.
 * Exits 0 when the hangup finished within `timeoutMs`, 1 otherwise. Returns an uninstall function.
 */
export function installGracefulShutdown(
  session: { hangup(reason: string): Promise<void> },
  logger: Logger,
  opts: { timeoutMs?: number; proc?: Process } = {},
): () => void {
  const proc = opts.proc ?? process;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let stopping = false;

  const handler = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const clean = await withTimeout(
      session.hangup("shutdown").then(() => true),
      timeoutMs,
      false,
    );
    if (!clean) logger.error({ timeoutMs }, "shutdown timed out");
    logger.flush();
    proc.exit(clean ? 0 : 1);
  };

  proc.once("SIGINT", handler);
  proc.once("SIGTERM", handler);
  return () => {
    proc.off("SIGINT", handler);
    proc.off("SIGTERM", handler);
  };
}
