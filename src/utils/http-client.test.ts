import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry, shortError } from './http-client.js';

const ok = (body = '{}', status = 200, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: (k: string) => headers[k] ?? null } }) as unknown as Response;

describe('fetchWithRetry', () => {
  it('returns the response on first success without retrying', async () => {
    const fetchImpl = vi.fn(async () => ok('{"a":1}'));
    const res = await fetchWithRetry('https://x.test', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 3 });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then succeeds, honoring Retry-After', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok('slow down', 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(ok('{"a":2}'));
    const res = await fetchWithRetry('https://x.test', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2, backoffMs: 5 });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries and returns the last failure', async () => {
    const fetchImpl = vi.fn(async () => ok('nope', 503));
    const res = await fetchWithRetry('https://x.test', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2, backoffMs: 5 });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 (non-retryable status)', async () => {
    const fetchImpl = vi.fn(async () => ok('missing', 404));
    const res = await fetchWithRetry('https://x.test', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 3 });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rethrows network errors after retries are exhausted', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(
      fetchWithRetry('https://x.test', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 1, backoffMs: 5 }),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('shortError', () => {
  it('flattens a nested fetch TypeError to a one-liner with its cause', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { cause: { message: 'getaddrinfo EAI_AGAIN gamma-api.polymarket.com' } },
    });
    const line = shortError(err);
    expect(line).toContain('fetch failed');
    expect(line).toContain('EAI_AGAIN');
    expect(line).not.toContain('\n');
  });

  it('handles plain Error and unknown values', () => {
    expect(shortError(new Error('boom'))).toBe('boom');
    expect(shortError('string-err')).toBe('string-err');
    expect(shortError(undefined)).toBe('unknown error');
  });
});
