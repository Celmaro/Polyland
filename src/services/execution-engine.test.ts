/**
 * ExecutionEngine unit tests — the typed post-consensus execution boundary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionEngine, type ExecutionEngineConfig, type ExecutionEngineDeps } from './execution-engine.js';
import type { ConsensusSignal, ExecutionDecision, PipelineDecision } from './pipeline-types.js';
import type { TradingService } from './trading-service.js';
import type { SmartMoneyTrade } from './smart-money-service.js';

const CONFIG: ExecutionEngineConfig = {
  dryRun: true, orderType: 'FAK', maxSlippage: 0.03,
  minTradeSize: 10, maxSizePerTrade: 500, sizeScale: 0.5,
};

const SIGNAL: ConsensusSignal = {
  signalId: 'sig-1', conditionId: 'cond-1', marketSlug: 'will-x', outcome: 'Yes',
  category: 'politics', basketName: 'Politics Quorum', walletCount: 3,
  wallets: ['0xa', '0xb', '0xc'], consensusPrice: 0.6, totalSize: 400, winRate: 0.7, side: 'BUY',
};

const TRADE: SmartMoneyTrade = {
  traderAddress: '0xa', conditionId: 'cond-1', marketSlug: 'will-x', side: 'BUY',
  size: 400, price: 0.6, tokenId: 'tok-1', outcome: 'Yes', timestamp: Date.now(),
  isSmartMoney: true,
};

const BASKET = { name: 'Politics Quorum', category: 'politics' as const, wallets: ['0xa'], quorum: 3, windowMs: 3_600_000, enabled: true, winRate: 0.7 };

function makeDeps(overrides: Partial<ExecutionEngineDeps> = {}): ExecutionEngineDeps {
  return {
    tickSizeFor: () => 0.01,
    feeRateFor: () => 200,
    bankrollFor: () => 1000,
    basketSpendGet: () => 0,
    basketSpendAdd: () => {},
    phaseEdge: () => ({ minEdge: 0, minProb: 0 }),
    liquidityCheck: async () => true,
    onPositionOpened: () => {},
    onDedupFire: () => {},
    onAntiSniperFire: () => {},
    auditStore: { recordFire: () => 'id' },
    ...overrides,
  };
}

function makeTrading(overrides: Partial<TradingService> = {}): TradingService {
  return {
    createMarketOrder: async () => ({ success: true, orderId: 'ord-1' }),
    ...overrides,
  } as unknown as TradingService;
}

describe('ExecutionEngine', () => {
  it('rejects below minTradeSize with reason min_size', async () => {
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG, dryRun: false });
    const small: ConsensusSignal = { ...SIGNAL, totalSize: 1, winRate: 0.99 };
    const decision = await engine.evaluate(small, TRADE, BASKET);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toBe('min_size');
  });

  it('rejects near-certain entries above the price ceiling with reason edge', async () => {
    // Regression: audit showed the bot buying esports/soccer at 0.90-0.95
    // (negative expectancy). The price ceiling must reject regardless of
    // winRate, even when edge would otherwise clear.
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG, maxEntryPrice: 0.85 });
    const hot: ConsensusSignal = { ...SIGNAL, consensusPrice: 0.92, winRate: 0.95 };
    const decision = await engine.evaluate(hot, TRADE, BASKET);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toBe('edge');
      expect(decision.detail ?? '').toContain('price_ceiling');
    }
  });

  it('floor-clamps a sub-min but non-dust consensus up to minTradeSize instead of rejecting', async () => {
    // Regression: sizing proportional to leader shares scaled thin leaders
    // below min order notional (audit: 1047 min_size rejections). A real
    // consensus with a notional above the $1 dust bound should be clamped up
    // to minTradeSize, not rejected.
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG }); // minTradeSize 10
    // totalSize 10 -> amount 10*0.5*0.6 = $3 >= $1 dust but < $10 min.
    const thin: ConsensusSignal = { ...SIGNAL, totalSize: 10, winRate: 0.7 };
    const decision = await engine.evaluate(thin, TRADE, BASKET);
    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.value.amountUsd).toBeGreaterThanOrEqual(CONFIG.minTradeSize * 0.99);
    }
  });

  it('rejects when riskManager.canTrade() is false with reason risk', async () => {
    const risk = { canTrade: () => false, isBasketKilled: () => false } as unknown as import('./risk-manager.js').RiskManager;
    const engine = new ExecutionEngine(makeTrading(), risk, makeDeps(), CONFIG);
    const decision = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toBe('risk');
  });

  it('execute on dryRun returns ok and calls onPositionOpened + basketSpendAdd', async () => {
    let opened = 0;
    let spent = 0;
    const deps = makeDeps({
      basketSpendAdd: (_c, amount) => { spent += amount; },
      onPositionOpened: () => { opened++; },
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, CONFIG);
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.orderId).toMatch(/^dry_run_/);
        expect(opened).toBe(1);
        expect(spent).toBeGreaterThan(0);
      });

  it('execute failure releases the reservation (a later execute can still reserve)', async () => {
    let calls = 0;
    const flaky: TradingService = {
      createMarketOrder: async () => {
        calls++;
        if (calls === 1) return { success: false, errorMsg: 'nope' };
        return { success: true, orderId: 'ord-2' };
      },
    } as unknown as TradingService;
    const engine = new ExecutionEngine(flaky, null, makeDeps(), { ...CONFIG, dryRun: false });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);

    const first = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(first.ok).toBe(false);
    expect(engine.failed).toBe(1);

    // R7: a retry of the SAME signal must NOT re-submit (dispatched-set guard).
    const retrySame = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(retrySame.ok).toBe(false);
    expect(calls).toBe(1); // no re-submission

    // Reservation release is still verified: a DIFFERENT signal can reserve+fill.
    const different = {
      accepted: true,
      value: { signal: { ...SIGNAL, signalId: 'sig-1b', conditionId: 'cond-1b', consensusPrice: 0.40 }, amountUsd: 5, price: 0.40, dryRun: false },
    } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>;
    const second = await engine.execute(different, { ...TRADE, conditionId: 'cond-1b', tokenId: 'tok-1b' }, BASKET);
    expect(second.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('ExecutionEngine stale-quote gating (P1)', () => {
  const T0 = 1_700_000_000_000;
  afterEach(() => { vi.useRealTimers(); });

  it('rejects a signal whose observed quote is older than maxQuoteAgeMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG, maxQuoteAgeMs: 30_000 });
    const stale: ConsensusSignal = { ...SIGNAL, observedAt: T0 - 60_000 };
    const decision = await engine.evaluate(stale, TRADE, BASKET);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toBe('stale_quote');
  });

  it('accepts a signal observed within the quote TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG, maxQuoteAgeMs: 30_000 });
    const fresh: ConsensusSignal = { ...SIGNAL, observedAt: T0 - 5_000 };
    const decision = await engine.evaluate(fresh, TRADE, BASKET);
    expect(decision.accepted).toBe(true);
  });

  it('treats signals without observedAt as legacy-fresh (no false block)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const engine = new ExecutionEngine(makeTrading(), null, makeDeps(), { ...CONFIG, maxQuoteAgeMs: 30_000 });
    const decision = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(decision.accepted).toBe(true);
  });

  it('execute() rejects a final planner price above the shared entry ceiling', async () => {
    const deps = makeDeps();
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, maxEntryPrice: 0.85 });
    const forced = {
      accepted: true,
      value: { signal: { ...SIGNAL, consensusPrice: 0.80 }, amountUsd: 5, price: 0.90, dryRun: true },
    } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>;
    const result = await engine.execute(forced, TRADE, BASKET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('entry_ceiling');
    expect(engine.failed).toBe(0);
    expect(engine.skipped.entryCeiling).toBe(1);
  });

  it('execute() rejects a duplicate signalId (idempotency: no double-fill)', async () => {
    let spent = 0;
    const deps = makeDeps({
      basketSpendAdd: (_c, amount) => { spent += amount; },
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, CONFIG);
    const decision = {
      accepted: true,
      value: { signal: { ...SIGNAL, signalId: 'sig-dup-1', consensusPrice: 0.40 }, amountUsd: 5, price: 0.40, dryRun: true },
    } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>;
    const first = await engine.execute(decision, TRADE, BASKET);
    expect(first.ok).toBe(true);
    const second = await engine.execute(decision, TRADE, BASKET);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('stale_quote'); // counted as fail-closed skip
    expect(spent).toBeGreaterThan(0); // only the FIRST fill spent
    const spentAfterFirst = spent;
    await engine.execute(decision, TRADE, BASKET);
    expect(spent).toBe(spentAfterFirst); // no third fill
  });

  it('execute() blocks a market below the 24h-volume anti-honeypot floor', async () => {
    let spent = 0;
    process.env.MIN_MARKET_VOLUME24H_USD = '5000';
    const deps = makeDeps({
      basketSpendAdd: (_c, amount) => { spent += amount; },
      marketVolume24h: async () => ({ volume24hr: 800, liquidity: 200 }),
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, CONFIG);
    const decision = {
      accepted: true,
      value: { signal: { ...SIGNAL, consensusPrice: 0.40 }, amountUsd: 5, price: 0.40, dryRun: true },
    } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>;
    const result = await engine.execute(decision, TRADE, BASKET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quality');
    expect(spent).toBe(0);
    delete process.env.MIN_MARKET_VOLUME24H_USD;
  });

  it('execute() on a stale signal does not reserve/spend and returns ok:false', async () => {
      vi.useFakeTimers();
    vi.setSystemTime(T0);
    let spent = 0;
    let opened = 0;
    const deps = makeDeps({
      basketSpendAdd: (_c, amount) => { spent += amount; },
      onPositionOpened: () => { opened++; },
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, maxQuoteAgeMs: 30_000 });
    const stale: ConsensusSignal = { ...SIGNAL, observedAt: T0 - 60_000 };
    const decision = await engine.evaluate(stale, TRADE, BASKET);
    expect(decision.accepted).toBe(false);
    // Direct execute() must also fail closed (defense in depth) — even when
    // the decision object predates the staleness check.
    const forced = { accepted: true, reason: 'edge', value: { signal: stale, amountUsd: 100, price: 0.6, dryRun: true } } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>;
    const result = await engine.execute(forced, TRADE, BASKET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_quote');
    expect(spent).toBe(0);
    expect(opened).toBe(0);
    // Stale-quote cancellation is a skip (fail-closed), not an order failure.
    expect(engine.failed).toBe(0);
    expect(engine.skipped.staleQuote).toBe(1);
  });
});

describe('ExecutionEngine depth-aware dry-run fills (P1-5 shared fill engine)', () => {
  it('records the executable VWAP and partial size when dry-run depth-aware fills are on', async () => {
    let fired: Record<string, unknown> | null = null;
    let openedShares = 0;
    const deps = makeDeps({
      auditStore: { recordFire: (params: Record<string, unknown>) => { fired = params; return 'id'; } },
      onPositionOpened: (_tokenId: unknown, _usd: unknown, shares: unknown) => { openedShares = shares as number; },
      bookLookup: async () => ({
        asks: [{ price: 0.60, size: 50 }],
        bids: [],
        minOrderSize: 0,
        tickSize: 0.01,
        timestamp: Date.now(),
      }),
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, depthAwareFills: true });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(result.ok).toBe(true);
    // Depth caps at 50 shares @ 0.60; audit must record the true fill.
    expect(fired).not.toBeNull();
    expect(fired!.pricePaid).toBeCloseTo(0.60, 6);
    expect(fired!.size).toBeCloseTo(50, 6);
    expect(openedShares).toBeCloseTo(50, 6);
  });

  it('fails closed (ok:false, no spend) when the book is unavailable and depth-aware fills are on', async () => {
    let spent = 0;
    const deps = makeDeps({
      basketSpendAdd: (_c, amount) => { spent += amount; },
      bookLookup: async () => null,
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, depthAwareFills: true });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(result.ok).toBe(false);
    // A missing live book is a LIQUIDITY skip, not an order failure — the
    // audit's failed=6 conflation fixed: `failed` counts only real order
    // failures, liquidity issues count separately. (execution-engine.ts:143)
    expect(engine.failed).toBe(0);
    expect(engine.skipped.depthUnknown).toBe(1);
    expect(spent).toBe(0);
  });

  it('keeps legacy full-fill behavior when depth-aware fills are off', async () => {
    let fired: Record<string, unknown> | null = null;
    const deps = makeDeps({
      auditStore: { recordFire: (params: Record<string, unknown>) => { fired = params; return 'id'; } },
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, depthAwareFills: false });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(result.ok).toBe(true);
    expect(fired!.pricePaid).toBe(SIGNAL.consensusPrice); // legacy: consensus, no book
  });
});

describe('ExecutionEngine complement mirroring (R2)', () => {
  it('mirrors to the complement when the target ask is walled', async () => {
    let fired: Record<string, unknown> | null = null;
    const deps = makeDeps({
      auditStore: { recordFire: (params: Record<string, unknown>) => { fired = params; return 'id'; } },
      onPositionOpened: () => {},
      // target book: ask walled at 0.99
      bookLookup: async () => ({ asks: [{ price: 0.99, size: 100 }], bids: [{ price: 0.5, size: 10 }], minOrderSize: 0, tickSize: 0.01, timestamp: Date.now() }),
      // complement (NO) book: real ask at 0.41
      complementBookLookup: async () => ({ asks: [{ price: 0.41, size: 1000 }], bids: [], minOrderSize: 0, tickSize: 0.01, timestamp: Date.now() }),
      complementTokenFor: async () => 'no-tok',
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, depthAwareFills: true, complementMirror: true, maxSlippage: 0.03 });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(result.ok).toBe(true);
    expect(engine.mirrored).toBe(true);
    // audit tagged mirrored, fill at complement ~0.41
    expect(fired!.mirrored).toBe(true);
    expect(fired!.pricePaid).toBeLessThan(0.5);
  });

  it('does not mirror when complement mirroring is disabled', async () => {
    const deps = makeDeps({
      bookLookup: async () => ({ asks: [{ price: 0.99, size: 100 }], bids: [], minOrderSize: 0, tickSize: 0.01, timestamp: Date.now() }),
      complementBookLookup: async () => ({ asks: [{ price: 0.41, size: 1000 }], bids: [], minOrderSize: 0, tickSize: 0.01, timestamp: Date.now() }),
      complementTokenFor: async () => 'no-tok',
    });
    const engine = new ExecutionEngine(makeTrading(), null, deps, { ...CONFIG, depthAwareFills: true, complementMirror: false });
    const evaluated = await engine.evaluate(SIGNAL, TRADE, BASKET);
    expect(evaluated.accepted).toBe(true);
    const result = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
    expect(result.ok).toBe(false); // no-depth, not mirrored
    expect(engine.mirrored).toBe(false);
  });
});

describe('R7 — idempotency under faults (no double-fill)', () => {
  const decisionFor = (signalId: string) => ({
    accepted: true,
    value: { signal: { ...SIGNAL, signalId, consensusPrice: 0.40 }, amountUsd: 5, price: 0.40, dryRun: false },
  } as unknown as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>);

  it('never double-spends when a retry follows a thrown timeout', async () => {
    let orderCalls = 0;
    let spent = 0;
    const flaky: TradingService = {
      createMarketOrder: async () => { orderCalls++; throw new Error('fetch failed: connect timeout'); },
    } as unknown as TradingService;
    const deps = makeDeps({ basketSpendAdd: (_c, amount) => { spent += amount; } });
    const engine = new ExecutionEngine(flaky, null, deps, { ...CONFIG, dryRun: false });
    const d = decisionFor('sig-timeout');
    // First attempt: timeout -> unknown -> reconciliation required, no retry.
    await engine.execute(d, TRADE, BASKET);
    const callCountAfterFirst = orderCalls;
    const spentAfterFirst = spent;
    // Retry same signal (as a client would after a timeout): must NOT double-fire.
    await engine.execute(d, TRADE, BASKET);
    await engine.execute(d, TRADE, BASKET);
    expect(orderCalls).toBe(callCountAfterFirst); // no further venue submissions
    expect(spent).toBe(spentAfterFirst);          // no double-spend
  });

  it('never double-spends on an HTTP 429 retry of the same signal', async () => {
    let orderCalls = 0;
    let spent = 0;
    const rateLimited: TradingService = {
      createMarketOrder: async () => { orderCalls++; return { success: false, orderId: undefined, error: 'rate limit 429' }; },
    } as unknown as TradingService;
    const deps = makeDeps({ basketSpendAdd: (_c, amount) => { spent += amount; } });
    const engine = new ExecutionEngine(rateLimited, null, deps, { ...CONFIG, dryRun: false });
    const d = decisionFor('sig-429');
    await engine.execute(d, TRADE, BASKET);
    const calls = orderCalls;
    const sp = spent;
    await engine.execute(d, TRADE, BASKET); // client retries after 429
    expect(orderCalls).toBe(calls);
    expect(spent).toBe(sp);
  });

  it('marks the signal executed on a successful fill so a WS-drop re-delivery cannot double-fill', async () => {
    let orderCalls = 0;
    let spent = 0;
    const trading: TradingService = {
      createMarketOrder: async () => { orderCalls++; return { success: true, orderId: 'ord-ws' }; },
    } as unknown as TradingService;
    const deps = makeDeps({ basketSpendAdd: (_c, amount) => { spent += amount; } });
    const engine = new ExecutionEngine(trading, null, deps, { ...CONFIG, dryRun: false });
    const d = decisionFor('sig-wsdrop');
    const first = await engine.execute(d, TRADE, BASKET);
    expect(first.ok).toBe(true);
    const spentAfterFill = spent;
    // WS drops the ack; the caller re-sends the same signal — must be rejected.
    const redeliver = await engine.execute(d, TRADE, BASKET);
    expect(redeliver.ok).toBe(false);
    expect(spent).toBe(spentAfterFill);
  });

  it('rejects retry-after-submit (ambiguous success then duplicate dispatch)', async () => {
    let orderCalls = 0;
    let spent = 0;
    const trading: TradingService = {
      createMarketOrder: async () => { orderCalls++; return { success: true, orderId: 'ord-ambig' }; },
    } as unknown as TradingService;
    const deps = makeDeps({ basketSpendAdd: (_c, amount) => { spent += amount; } });
    const engine = new ExecutionEngine(trading, null, deps, { ...CONFIG, dryRun: false });
    const d = decisionFor('sig-ambig');
    await engine.execute(d, TRADE, BASKET);
    const spentAfterFirst = spent;
    // Re-dispatch (retry after submit ack) must not double-spend.
    await engine.execute(d, TRADE, BASKET);
    expect(spent).toBe(spentAfterFirst);
  });
});
