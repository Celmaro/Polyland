/**
 * walk-forward.ts — deterministic train/validation splitting and
 * config-fingerprint guards for threshold tuning.
 *
 * Why: tuning CopyScore/quorum/adverse-move thresholds against the SAME
 * window that evaluates them silently overfits. Split records by time into
 * train/validation, tune only on train, and refuse to trust validation
 * results unless the exact tuned config was re-applied (fingerprint match).
 */
import { createHash } from 'node:crypto';

/** Stable content hash of a config object (key-order independent). */
export function fingerprintConfig(config: Record<string, unknown>): string {
  const sorted = sortObject(config);
  const payload = JSON.stringify(sorted);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortObject((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface WalkForwardSplit<T> {
  train: T[];
  validation: T[];
}

/**
 * Deterministic time-ordered split: records sorted by settledAt ascending
 * (records without a timestamp count as earliest), first `trainFraction`
 * become the train window, the rest the locked validation window.
 */
export function splitWalkForward<T extends { settledAt?: number }>(
  records: T[],
  trainFraction: number,
): WalkForwardSplit<T> {
  if (!(trainFraction >= 0 && trainFraction <= 1)) {
    throw new Error(`trainFraction must be within [0,1], got ${trainFraction}`);
  }
  const sorted = [...records].sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const trainCount = Math.floor(sorted.length * trainFraction);
  return { train: sorted.slice(0, trainCount), validation: sorted.slice(trainCount) };
}

export interface WalkForwardValidation {
  ok: boolean;
  reason?: string;
}

/** Refuse to trust validation output unless the exact tuned config ran. */
export function validateWalkForward(
  trainConfigFingerprint: string,
  validationConfigFingerprint: string,
): WalkForwardValidation {
  if (trainConfigFingerprint !== validationConfigFingerprint) {
    return {
      ok: false,
      reason: `config fingerprint mismatch between train (${trainConfigFingerprint}) and validation (${validationConfigFingerprint})`,
    };
  }
  return { ok: true };
}
