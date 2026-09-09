/**
 * http-client.ts — one shared resilient HTTP layer for all REST calls.
 *
 * Adopted pattern (nahrek/polyledger http.py): retry with jittered
 * exponential backoff, honor `Retry-After`, retry only the statuses that
 * are transient (408/425/429/5xx), and treat a non-2xx after retries as a
 * real answer (never throw for an HTTP error — only for network failure).
 *
 * Also exports shortError(): the one-line error formatter the audit
 * demanded — the 1h/24h price-check path was logging full undici stack
 * dumps (113 lines in 14 min during the 09-09 Gamma DNS outage).
 */

export interface FetchRetryOptions {
  /** Number of retries AFTER the first attempt (default 2). */
  retries?: number;
  /** Base backoff in ms; each retry uses 0.5·base·2^attempt with full jitter (default 500). */
  backoffMs?: number;
  /** HTTP statuses worth retrying (default 408/425/429/500/502/503/504). */
  retryStatuses?: ReadonlySet<number>;
  /** Per-attempt timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Injectable fetcher (tests, or a custom agent). */
  fetchImpl?: typeof fetch;
  /** Called before each retry with the attempt number and status/error. */
  onRetry?: (attempt: number, reason: string) => void;
}

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    backoffMs = 500,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    timeoutMs = 10_000,
    fetchImpl = fetch,
    onRetry,
  } = options;

  let attempt = 0;
  // An HTTP error status (>= 400) returned by the server is a real answer —
  // keep it as the final result if retries are exhausted. Network exceptions
  // (DNS, connect, abort) are rethrown after retries.
  let lastHttpResponse: Response | null = null;

  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok || !retryStatuses.has(res.status) || attempt >= retries) {
        return res;
      }
      lastHttpResponse = res;
      onRetry?.(attempt + 1, `HTTP ${res.status}`);
      await sleepBackoff(attempt, backoffMs, res.headers.get('retry-after'));
    } catch (err) {
      if (attempt >= retries) throw err;
      onRetry?.(attempt + 1, shortError(err));
      await sleepBackoff(attempt, backoffMs, null);
    }
    attempt++;
  }
}

/** Jittered exponential backoff: 0.5·base·2^attempt, full jitter, Retry-After honored (capped 60s). */
async function sleepBackoff(attempt: number, baseMs: number, retryAfter: string | null): Promise<void> {
  let waitMs: number;
  if (retryAfter !== null) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) {
      waitMs = Math.min(secs * 1000, 60_000);
    } else {
      waitMs = baseMs;
    }
  } else {
    const exp = Math.min(6, attempt); // cap the exponent
    const max = 0.5 * baseMs * 2 ** exp;
    waitMs = Math.random() * max; // full jitter [0, max)
  }
  await new Promise((r) => setTimeout(r, waitMs));
}

/**
 * One-line error for log lines: `message (cause: cause.message)`.
 * Strips the multi-line undici stack/symbol dumps that flooded the 09-09
 * outage logs — the cause chain carries the real reason (EAI_AGAIN, etc.).
 */
export function shortError(err: unknown): string {
  if (err instanceof Error) {
    let causeMsg = '';
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 3) {
      const raw = cause instanceof Error ? cause.message : (cause as { message?: unknown } | null)?.message;
      const m = typeof raw === 'string' ? raw : '';
      if (m && m !== err.message) {
        causeMsg = m;
        break;
      }
      cause = (cause as { cause?: unknown }).cause;
      depth++;
    }
    return causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message;
  }
  if (typeof err === 'string') return err;
  return 'unknown error';
}
