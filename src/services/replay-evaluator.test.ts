import { describe, expect, it } from 'vitest';
import { ReplayEvaluator, summarizeReplay, type ReplayCandidate, type BookSnapshot } from './replay-evaluator.js';
const candidate = (overrides: Partial<ReplayCandidate> = {}): ReplayCandidate => ({
  candidateId: 'c1', conditionId: 'm1', tokenId: 't1', outcome: 'YES', side: 'BUY',
  price: 0.5, size: 10, tradeTimestamp: 1_000, discoveredAt: 1_100, decidedAt: 1_200,
  expectedProbability: 0.6, ...overrides,
});
const book = (asks: { price: number; size: number }[], timestamp = 1_200): BookSnapshot => ({
  asks, bids: [{ price: 0.49, size: 100 }], minOrderSize: 1, tickSize: 0.01, timestamp,
});
const evaluator = (b: BookSnapshot | null, overrides: Partial<ConstructorParameters<typeof ReplayEvaluator>[0]> = {}) =>
  new ReplayEvaluator({ ledger: [candidate()], bookLookup: async () => b, takerFeeBps: 0, defaultTakerDelayMs: 0, now: 1_300, ...overrides });
describe('ReplayEvaluator', () => {
  it('prices a BUY from the decision-time ask, not leader price', async () => {
    const [r] = await evaluator(book([{ price: 0.52, size: 100 }])).evaluateReplay();
    expect(r.verdict).toBe('executable');
    expect(r.executableVwap).toBe(0.52);
    expect(r.executableSize).toBe(10);
    expect(r.slippageBps).toBe(400);
  });
  it('rewards a decision-time ask better than the leader price', async () => {
    const [r] = await evaluator(book([{ price: 0.45, size: 100 }])).evaluateReplay();
    expect(r.verdict).toBe('executable');
    expect(r.executableVwap).toBe(0.45);
    expect(r.slippageBps).toBe(-1000);
  });
  it('blocks when no book exists at decision time', async () => {
    const [r] = await evaluator(null).evaluateReplay();
    expect(r.verdict).toBe('no_best_ask');
  });
  it('blocks an ask above the slippage cap', async () => {
    const [r] = await evaluator(book([{ price: 0.7, size: 100 }]), { maxSlippageBps: 500 }).evaluateReplay();
    expect(r.verdict).toBe('above_cap');
  });
  it('blocks stale candidates', async () => {
    const [r] = await evaluator(book([{ price: 0.52, size: 100 }]), { maxAgeMs: 50 }).evaluateReplay();
    expect(r.verdict).toBe('stale');
  });
  it('reports a partial depth fill', async () => {
    const [r] = await evaluator(book([{ price: 0.52, size: 3 }])).evaluateReplay();
    expect(r.verdict).toBe('executable');
    expect(r.executableSize).toBe(3);
    expect(r.partiallyFillable).toBe(true);
    expect(r.expectedFill).toBe(3);
  });
  it('blocks when the taker delay cannot be satisfied', async () => {
    const [r] = await evaluator(book([{ price: 0.52, size: 100 }]), { defaultTakerDelayMs: 250, now: 1_300 }).evaluateReplay();
    expect(r.verdict).toBe('taker_delay_failed');
  });
});
describe('summarizeReplay', () => {
  it('aggregates verdicts and execution metrics', async () => {
    const ev = new ReplayEvaluator({
      ledger: [
        candidate({ candidateId: 'ok' }),
        candidate({ candidateId: 'blocked', tokenId: 't2' }),
      ],
      bookLookup: async (tokenId) =>
        tokenId === 't1' ? book([{ price: 0.52, size: 100 }]) : null,
      takerFeeBps: 0,
      defaultTakerDelayMs: 0,
      now: 1_300,
    });
    const results = await ev.evaluateReplay();
    const summary = summarizeReplay(results);
    expect(summary.n).toBe(2);
    expect(summary.executable).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.byReason.no_best_ask).toBe(1);
    expect(summary.avgSlippageBps).toBe(400);
    expect(summary.avgLatencyMs).toBe(0);
  });
});
