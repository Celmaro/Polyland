/**
 * ExecutionEngine unit tests — the typed post-consensus execution boundary.
 */
import { describe, it, expect } from 'vitest';
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
