/**
 * submission-pipeline.ts — submit-ONCE order pipeline (pmxt/pykalshi pattern).
 *
 * Rules:
 *   - build → record intent → submit exactly once → classify the outcome
 *   - NEVER auto-retry a mutation; on ambiguous (timeout/network) outcome
 *     the submission is UNKNOWN and must be reconciled, not resubmitted.
 *   - deterministic client errors are REJECTED (no retry).
 */
import type { OrderResult } from './trading-service.js';

export type SubmissionClassification = 'accepted' | 'rejected' | 'unknown';

export interface SubmissionIntent {
  clientOrderId: string;
  tokenId?: string;
  side?: 'BUY' | 'SELL';
  amountUsd?: number;
  price?: number;
  orderType?: string;
  ts: number;
  dryRun?: boolean;
}

export interface SubmitOnceOptions {
  clientOrderId: string;
  submit: () => Promise<OrderResult>;
  recordIntent: (intent: SubmissionIntent) => void;
  intent?: Omit<SubmissionIntent, 'clientOrderId' | 'ts'>;
}

export interface SubmissionOutcome {
  classification: SubmissionClassification;
  orderId?: string;
  detail?: string;
  submittedOnce: true;
}

const AMBIGUOUS_MARKERS = ['timeout', 'timed out', 'fetch failed', 'connect timeout', 'econnrefused', 'econnreset', 'socket'];

/** Deterministic client error → rejected; timeout/network → unknown. */
export function classifySubmission(result: OrderResult): SubmissionClassification {
  if (result.success || result.orderId) return 'accepted';
  const msg = (result.errorMsg ?? '').toLowerCase();
  if (msg === '') return 'unknown';
  if (AMBIGUOUS_MARKERS.some((m) => msg.includes(m))) return 'unknown';
  return 'rejected';
}

/** Submit exactly once (never retry); always record the intent first. */
export async function submitOnce(opts: SubmitOnceOptions): Promise<SubmissionOutcome> {
  const now = Date.now();
  opts.recordIntent({ clientOrderId: opts.clientOrderId, ts: now, ...opts.intent });
  const result = await opts.submit();
  const classification = classifySubmission(result);
  return { classification, orderId: result.orderId, detail: result.errorMsg, submittedOnce: true };
}