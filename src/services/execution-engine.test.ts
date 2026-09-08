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
    expect(result.orderId).toMatch(/^dry_run_/);
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

    const second = await engine.execute(evaluated as Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, TRADE, BASKET);
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
    expect(spent).toBe(0);
    expect(opened).toBe(0);
    expect(engine.failed).toBe(1);
  });
});
