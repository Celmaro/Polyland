import { describe, it, expect, vi } from 'vitest';
import { classifySubmission, submitOnce } from './submission-pipeline.js';
import type { OrderResult } from './trading-service.js';

const accepted = (orderId = 'o1'): OrderResult => ({ success: true, orderId });
const rejected = (errorMsg: string): OrderResult => ({ success: false, errorMsg });

describe('classifySubmission', () => {
  it('maps a clean success to accepted', () => expect(classifySubmission(accepted())).toBe('accepted'));
  it('maps a server rejection to rejected', () => expect(classifySubmission(rejected('insufficient balance'))).toBe('rejected'));
  it('maps timeout/unknown to unknown (never assume)', () => {
    expect(classifySubmission(rejected('timeout'))).toBe('unknown');
    expect(classifySubmission(rejected('fetch failed'))).toBe('unknown');
    expect(classifySubmission(rejected('connect timeout'))).toBe('unknown');
  });
  it('maps deterministic client errors to rejected', () => {
    expect(classifySubmission(rejected('invalid price'))).toBe('rejected');
    expect(classifySubmission(rejected('missing tokenId'))).toBe('rejected');
  });
});

describe('submitOnce', () => {
  it('submits exactly once and records the intent', async () => {
    let calls = 0;
    const recorder = vi.fn();
    const result = await submitOnce({
      clientOrderId: 'co-1',
      submit: async () => { calls++; return accepted(); },
      recordIntent: recorder,
    });
    expect(calls).toBe(1);
    expect(result.classification).toBe('accepted');
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0][0].clientOrderId).toBe('co-1');
  });
  it('never auto-retries a submission (mutation safety)', async () => {
    let calls = 0;
    const result = await submitOnce({
      clientOrderId: 'co-2',
      submit: async () => { calls++; return rejected('timeout'); },
      recordIntent: () => {},
    });
    expect(calls).toBe(1);
    expect(result.classification).toBe('unknown');
  });
});