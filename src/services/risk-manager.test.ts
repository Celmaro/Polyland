import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RiskManager,
  DEFAULT_RISK_CONFIG,
  type TradeRecord,
} from './risk-manager.js';

const ONE_DAY = 24 * 60 * 60_000;
const ONE_MONTH = 30 * ONE_DAY;

function trade(pnlUsd: number, ts = Date.now()): TradeRecord {
  return { pnlUsd, ts, side: pnlUsd < 0 ? 'SELL' : 'BUY' };
}

describe('RiskManager halts — windowed P&L', () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager({}, 1000); // daily 5% = $50
  });

  it('halts daily at 5% of capital', () => {
    risk.recordTrade(trade(-20));
    risk.recordTrade(trade(-20));
    expect(risk.canTrade()).toBe(true);
    risk.recordTrade(trade(-20)); // -60 > -50
    expect(risk.canTrade()).toBe(false);
    expect(risk.snapshot().haltReason).toBe('daily_loss');
  });

  it('trades outside the 24h window do not count toward the daily halt', () => {
    risk.recordTrade(trade(-60, Date.now() - 2 * ONE_DAY));
    expect(risk.canTrade()).toBe(true);
    expect(risk.snapshot().dailyPnl).toBe(0);
  });

  it('incremental windowed PnL matches brute-force recompute over a varied trade sequence', () => {
    const now = Date.now();
    const seq: TradeRecord[] = [
      trade(-30, now - 40 * ONE_DAY),  // older than monthly window
      trade(10, now - 10 * ONE_DAY),   // in monthly, outside daily
      trade(5, now - 3 * ONE_DAY),
      trade(-8, now - ONE_DAY - 60_000),
      trade(12, now - 60_000),         // in daily window
      trade(-4, now),                  // in daily window
    ];
    for (const t of seq) risk.recordTrade(t);

    const snap = risk.snapshot();
    const bruteDaily = seq.filter((t) => now - t.ts <= ONE_DAY).reduce((a, t) => a + t.pnlUsd, 0);
    const bruteMonthly = seq.filter((t) => now - t.ts <= ONE_MONTH).reduce((a, t) => a + t.pnlUsd, 0);
    expect(snap.dailyPnl).toBeCloseTo(bruteDaily, 10);
    expect(snap.monthlyPnl).toBeCloseTo(bruteMonthly, 10);
  });

  it('reports capital halts ahead of an active consecutive-loss pause (was masked)', () => {
    risk = new RiskManager({ maxConsecutiveLosses: 3, pauseOnBreachMinutes: 60 }, 1000);
    risk.recordTrade(trade(-10));
    risk.recordTrade(trade(-10));
    risk.recordTrade(trade(-10));
    expect(risk.snapshot().haltReason).toBe('consecutive_losses');
    // Add a capital breach on top: daily moves to -60 (> 5% = -50).
    risk.recordTrade(trade(-30));
    expect(risk.snapshot().haltReason).toBe('daily_loss'); // must not hide behind the pause
  });
});

describe('RiskManager persistence (P6 — halts survive restart)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-'));
  });

  afterEach(() => {
    RiskManager.enablePersistence('');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores trade history so a breached daily halt survives a redeploy', () => {
    const stateFile = path.join(tmpDir, 'risk-state.json');
    RiskManager.enablePersistence(stateFile);

    const session1 = new RiskManager({}, 1000);
    session1.recordTrade(trade(-20));
    session1.recordTrade(trade(-20));
    session1.recordTrade(trade(-25)); // daily = -65, over the 5% (-50) limit
    expect(session1.canTrade()).toBe(false);
    expect(session1.snapshot().haltReason).toBe('daily_loss');

    // Simulate redeploy: brand-new instance, same persisted state.
    const session2 = new RiskManager({}, 1000);
    session2.loadPersistedState();
    expect(session2.canTrade()).toBe(false);
    expect(session2.snapshot().haltReason).toBe('daily_loss');
    expect(session2.snapshot().dailyPnl).toBeCloseTo(-65, 10);
  });

  it('restores basket kill-switch state so a killed basket stays killed', () => {
    const stateFile = path.join(tmpDir, 'risk-state.json');
    RiskManager.enablePersistence(stateFile);

    const session1 = new RiskManager({}, 1000);
    // Establish a baseline first, then collapse the recent window.
    for (let i = 0; i < 20; i++) session1.recordBasketOutcome('Crypto Quorum', true);
    for (let i = 0; i < 20; i++) session1.recordBasketOutcome('Crypto Quorum', false);
    expect(session1.isBasketKilled('Crypto Quorum')).toBe(true);

    const session2 = new RiskManager({}, 1000);
    session2.loadPersistedState();
    expect(session2.isBasketKilled('Crypto Quorum')).toBe(true);
  });
});

describe('RiskManager basket kill switch — baseline vs fair coin', () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager({}, 1000);
  });

  it('kills a basket that collapses from a strong baseline', () => {
    // Baseline: 60 settles at 0.75, with a HEALTHY recent window (last 20 = 15W/5L).
    // (The old test put the losing tail inside the recent window and killed
    //  at the baseline stage — the recent window must be healthy first.)
    const baseline = new Array(40).fill(true); // healthy recent window, baseline 1.00
    for (const w of baseline) risk.recordBasketOutcome('Collapse Basket', w);
    expect(risk.isBasketKilled('Collapse Basket')).toBe(false);
    // Collapse: next 20 all losses → recent window 0.00.
    for (let i = 0; i < 20; i++) risk.recordBasketOutcome('Collapse Basket', false);
    expect(risk.isBasketKilled('Collapse Basket')).toBe(true);
  });

  it('kills on drift from its OWN baseline even when recent rate stays AT coin-flip (old fair-coin rule would pass)', () => {
    // Strong long-run baseline: 480 consecutive wins. This deliberately keeps
    // the recent window healthy throughout baseline construction, avoiding a
    // premature kill before the drift being tested.
    for (let i = 0; i < 480; i++) risk.recordBasketOutcome('Slumping Basket', true);
    expect(risk.isBasketKilled('Slumping Basket')).toBe(false);

    // Slump: recent 20 at exactly 0.50 (still not below a coin flip).
    for (let i = 0; i < 10; i++) risk.recordBasketOutcome('Slumping Basket', true);
    for (let i = 0; i < 10; i++) risk.recordBasketOutcome('Slumping Basket', false);
    // Total 500: baseline = 480/500 = 0.96. 2σ = 2*sqrt(0.96*0.04/20) ≈ 0.088.
    // Threshold ≈ 0.872 > 0.50 → KILLED.
    // Old fair-coin rule: requires < 0.5 - 2*sqrt(0.25/20) = 0.276 → 0.50 passes → NOT killed.
    // This is the discriminator: the baseline fix catches drift the coin-flip null missed.
    expect(risk.isBasketKilled('Slumping Basket')).toBe(true);
  });

  it('a basket hovering near its own baseline is never killed', () => {
    for (let i = 0; i < 200; i++) risk.recordBasketOutcome('Healthy Basket', i % 2 === 0);
    expect(risk.isBasketKilled('Healthy Basket')).toBe(false);
  });
});

describe('RiskManager sanity', () => {
  it('dynamic sizing stays within [min, max] bands', () => {
    const risk = new RiskManager({}, 1000);
    // 4 losses (must stay BELOW maxConsecutiveLosses=6, which would trip the
    // pause halt and make sizeOrder return 0).
    for (let i = 0; i < 4; i++) risk.recordTrade(trade(-1));
    const snap = risk.snapshot();
    const minMult = DEFAULT_RISK_CONFIG.minPositionPct / DEFAULT_RISK_CONFIG.basePositionPct;
    const maxMult = DEFAULT_RISK_CONFIG.maxPositionPct / DEFAULT_RISK_CONFIG.basePositionPct;
    expect(snap.sizeMultiplier).toBeGreaterThanOrEqual(minMult);
    expect(snap.sizeMultiplier).toBeLessThanOrEqual(maxMult);
    const sized = risk.sizeOrder(100);
    expect(sized).toBeGreaterThanOrEqual(1000 * DEFAULT_RISK_CONFIG.minPositionPct);
    expect(sized).toBeLessThanOrEqual(1000 * DEFAULT_RISK_CONFIG.maxPositionPct);
  });

  it('sizeOrder returns 0 when halted', () => {
    const risk = new RiskManager({}, 1000);
    risk.recordTrade(trade(-60));
    expect(risk.sizeOrder(100)).toBe(0);
  });
});