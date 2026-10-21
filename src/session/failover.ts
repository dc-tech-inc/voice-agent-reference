import * as z from "zod";
import { ProviderError, type ToolSpec, type VoiceProvider } from "../provider/types.js";

export type FailoverPolicy = {
  /** A provider that is not ready within this time counts as a failed attempt. */
  connectTimeoutMs: number;
  /** How often the active provider is health-checked. */
  healthIntervalMs: number;
  /** A health check that does not answer within this time counts as unhealthy. */
  healthTimeoutMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  maxAttemptsPerProvider: number;
  /** Audio kept while no provider is active; older audio is dropped first. */
  audioBufferMs: number;
};

export const DEFAULT_POLICY: FailoverPolicy = {
  connectTimeoutMs: 5000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 5000,
  backoffBaseMs: 250,
  backoffCapMs: 4000,
  maxAttemptsPerProvider: 3,
  audioBufferMs: 2000,
};

const positiveMs = z.number().int().positive();
const policySchema = z.object({
  connectTimeoutMs: positiveMs,
  healthIntervalMs: positiveMs,
  healthTimeoutMs: positiveMs,
  backoffBaseMs: z.number().int().nonnegative(),
  backoffCapMs: z.number().int().nonnegative(),
  maxAttemptsPerProvider: z.number().int().min(1),
  audioBufferMs: z.number().int().nonnegative(),
});

/** Merges overrides into the defaults and validates the result. Throws naming the invalid fields. */
export function resolvePolicy(overrides: Partial<FailoverPolicy> = {}): FailoverPolicy {
  const parsed = policySchema.safeParse({ ...DEFAULT_POLICY, ...overrides });
  if (!parsed.success) {
    throw new Error(`invalid failover policy: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^(retry-1))). `retry` starts at 1. */
export function backoffDelay(retry: number, policy: FailoverPolicy, random: () => number): number {
  const ceiling = Math.min(policy.backoffCapMs, policy.backoffBaseMs * 2 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

/** setTimeout as a promise that ends early (without error) when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError("CONNECT_FAILED", err instanceof Error ? err.message : String(err), true);
}

/**
 * One connect attempt with a hard timeout. The timeout does not trust the provider to honour the
 * abort signal: the attempt fails on time even if `connect()` never settles.
 */
export async function connectOnce(
  provider: VoiceProvider,
  cfg: { instructions: string; tools: ToolSpec[] },
  timeoutMs: number,
  outer: AbortSignal,
): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([outer, timeout.signal]);
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () =>
        reject(
          outer.aborted
            ? new ProviderError("CONNECT_ABORTED", "session ended", false)
            : new ProviderError("CONNECT_TIMEOUT", `not ready within ${timeoutMs} ms`, true),
        );
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      provider.connect({ ...cfg, signal }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type FailoverRun = {
  providers: VoiceProvider[];
  /** Provider indexes in the order to try them. */
  order: number[];
  /** Providers that failed in a way retrying will not fix. Updated in place. */
  disabled: Set<number>;
  cfg: { instructions: string; tools: ToolSpec[] };
  policy: FailoverPolicy;
  random: () => number;
  signal: AbortSignal;
  onAttemptFailed: (provider: VoiceProvider, error: ProviderError, attempt: number) => void;
};

/**
 * Tries each provider in `order` up to `maxAttemptsPerProvider` times, with backoff between
 * attempts on the same provider. Returns the index of the provider that became ready, or
 * undefined when every provider is exhausted or the signal aborted.
 */
export async function connectWithFailover(run: FailoverRun): Promise<number | undefined> {
  const { policy, signal } = run;
  for (const index of run.order) {
    if (run.disabled.has(index)) continue;
    const provider = run.providers[index]!;
    for (let attempt = 1; attempt <= policy.maxAttemptsPerProvider; attempt++) {
      if (attempt > 1) await sleep(backoffDelay(attempt - 1, policy, run.random), signal);
      if (signal.aborted) return undefined;
      try {
        await connectOnce(provider, run.cfg, policy.connectTimeoutMs, signal);
        return index;
      } catch (err) {
        const error = toProviderError(err);
        await provider.close().catch(() => {});
        if (signal.aborted) return undefined;
        run.onAttemptFailed(provider, error, attempt);
        if (!error.retryable) {
          run.disabled.add(index);
          break;
        }
      }
    }
  }
  return undefined;
}
