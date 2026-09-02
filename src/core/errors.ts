/**
 * Unified error handling for Polymarket SDK
 */

export enum ErrorCode {
  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',

  // Authentication errors
  AUTH_FAILED = 'AUTH_FAILED',
  API_KEY_EXPIRED = 'API_KEY_EXPIRED',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',

  // Data errors
  MARKET_NOT_FOUND = 'MARKET_NOT_FOUND',
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  INVALID_RESPONSE = 'INVALID_RESPONSE',

  // Trading errors
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  ORDER_REJECTED = 'ORDER_REJECTED',
  ORDER_FAILED = 'ORDER_FAILED',
  MARKET_CLOSED = 'MARKET_CLOSED',
  TRADING_RESTRICTION = 'TRADING_RESTRICTION',
  INSUFFICIENT_LIQUIDITY = 'INSUFFICIENT_LIQUIDITY',

  // API errors
  API_ERROR = 'API_ERROR',

  // Internal errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  // Configuration errors
  INVALID_CONFIG = 'INVALID_CONFIG',
}

/** Restriction type from Polymarket CLOB trading restriction responses */
export type RestrictionType = 'cancel_only' | 'post_only' | 'restarting';

export class PolymarketError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable: boolean = false,
    public originalError?: Error,
    /** For TRADING_RESTRICTION errors: what restriction is active */
    public restrictionType?: RestrictionType,
    /** Server-reported Retry-After ms (from headers or body) */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PolymarketError';
  }

  /**
   * Create error from HTTP response status
   */
  static fromHttpError(status: number, body?: unknown): PolymarketError {
    const bodyMessage =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : '';

    switch (status) {
      case 429:
        return new PolymarketError(
          ErrorCode.RATE_LIMITED,
          bodyMessage || 'Rate limited',
          true
        );
      case 401:
        return new PolymarketError(
          ErrorCode.AUTH_FAILED,
          bodyMessage || 'Authentication failed'
        );
      case 403:
        return new PolymarketError(
          ErrorCode.AUTH_FAILED,
          bodyMessage || 'Forbidden'
        );
      case 404:
        return new PolymarketError(
          ErrorCode.MARKET_NOT_FOUND,
          bodyMessage || 'Resource not found'
        );
      case 400:
        // Check for trading restriction in body
        if (body && typeof body === 'object') {
          const r = (body as Record<string, unknown>).restriction;
          if (typeof r === 'string') {
            const restrictionMap: Record<string, RestrictionType> = {
              cancel_only: 'cancel_only',
              post_only: 'post_only',
              restarting: 'restarting',
            };
            const rt = restrictionMap[r];
            if (rt) {
              const retryAfter =
                typeof (body as Record<string, unknown>).retryAfterMs === 'number'
                  ? Number((body as Record<string, unknown>).retryAfterMs)
                  : undefined;
              return new PolymarketError(
                ErrorCode.TRADING_RESTRICTION,
                `Trading restriction: ${r}${retryAfter ? ` (retry in ${retryAfter}ms)` : ''}`,
                rt === 'restarting',
                undefined,
                rt,
                retryAfter,
              );
            }
          }
        }
        return new PolymarketError(
          ErrorCode.INVALID_RESPONSE,
          bodyMessage || 'Bad request'
        );
      default:
        return new PolymarketError(
          ErrorCode.NETWORK_ERROR,
          bodyMessage || `HTTP ${status}`,
          status >= 500
        );
    }
  }
}

/**
 * Exponential backoff with full jitter (AWS architecture blog pattern).
 * Caps at maxDelayMs to avoid unbounded waits.
 * Jitter prevents thundering-herd when many clients reconnect simultaneously.
 */
function sleepWithJitter(baseDelayMs: number, attempt: number, maxDelayMs = 30_000): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  // Full jitter: uniform random in [0, capped]
  return Math.random() * capped;
}

/**
 * Sanitize an error message for safe logging.
 * Redacts private keys, signatures, and other sensitive hex strings.
 *
 * Targets:
 * - Private keys: 64 hex chars (前后没有 0x 前缀)
 * - 0x-prefixed keys: 0x + 32+ hex chars (旧版格式)
 * - Signatures: 64 hex chars after '0x'
 * - JWT/bearer tokens
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    // Redact bare 64-char hex strings (raw private keys)
    .replace(/([\s"(,=[])([a-fA-F0-9]{64})([\s")],=]|$)/g, '$1[REDACTED]$3')
    // Redact 0x-prefixed keys/sigs (32+ hex chars after 0x)
    .replace(/0x([a-fA-F0-9]{32,})/g, '0x[REDACTED]')
    // Redact JWT/bearer tokens in Authorization headers
    .replace(/(Authorization[\s:=]+)[^"\s,}]+/gi, '$1[REDACTED]');
}

/**
 * Retry decorator for async functions
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1_000, maxDelayMs = 30_000 } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (error instanceof PolymarketError && !error.retryable) {
        throw error;
      }
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, sleepWithJitter(baseDelayMs, attempt, maxDelayMs)));
      }
    }
  }

  throw lastError;
}
