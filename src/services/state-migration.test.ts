import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateStore } from './state-store.js';
import { VoteStateStore } from './vote-state-store.js';
import { RiskManager } from './risk-manager.js';
import { SignalAuditStore } from './signal-audit-store.js';

describe('runtime persistence restart equivalence', () => {
  it('stores vote namespace through the shared state boundary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-migrate-'));
    try {
      const shared = new JsonStateStore(path.join(dir, 'polyland.json'));
      const votes = new VoteStateStore(path.join(dir, 'legacy-votes.json'));
      votes.setStateStore(shared);
      votes.votes.set('condition', new Map([
        ['Yes', new Map([['wallet', { wallet: 'wallet', side: 'BUY', price: 0.5, size: 10, timestamp: Date.now(), tier: 'PRIMARY' }]])],
      ]));
      votes.lastFired.set('condition:Yes', Date.now());
      await votes.save();
      const loaded = await shared.load();
      expect(loaded?.quorum).toBeDefined();
      const restored = new VoteStateStore(path.join(dir, 'legacy-votes.json'));
      await restored.load();
      expect(restored.votes.get('condition')?.get('Yes')?.get('wallet')?.price).toBe(0.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps risk restart behavior while mirroring the namespace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-migrate-'));
    try {
      const shared = new JsonStateStore(path.join(dir, 'polyland.json'));
      const legacy = path.join(dir, 'risk.json');
      RiskManager.enablePersistence(legacy);
      const first = new RiskManager({}, 1000);
      first.setStateStore(shared);
      first.recordTrade({ pnlUsd: -60, ts: Date.now(), side: 'SELL' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sharedState = await shared.load();
      expect(sharedState?.risk).toBeDefined();
      const second = new RiskManager({}, 1000);
      second.loadPersistedState();
      expect(second.snapshot().dailyPnl).toBe(-60);
      expect(second.canTrade()).toBe(false);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 25));
      RiskManager.enablePersistence('');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restart boot-sequence fixture (P1)', () => {
  it('rebuilds the P&L/streak snapshot from the replayed audit AND preserves the risk halt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-restart-'));
    const auditPath = path.join(dir, 'signal-audit.jsonl');
    const riskPath = path.join(dir, 'risk.json');
    try {
      SignalAuditStore.enableJsonl(auditPath);
      RiskManager.enablePersistence(riskPath);
      const fire = (store: SignalAuditStore, conditionId: string, pricePaid: number, size: number) =>
        store.recordFire({
          conditionId, marketSlug: `m-${conditionId}`, outcome: 'Yes', side: 'BUY',
          pricePaid, size, feePerShare: 0, winRate: 0.6, basket: 'Crypto Quorum',
          wallets: ['0xa'], category: 'crypto',
        });

      // ---- Session A: one winner (+3.00), one loser (-10.00), risk halts ----
      const auditA = new SignalAuditStore();
      fire(auditA, 'c1', 0.4, 10);
      auditA.markExited('c1', 0.7, 'EDGE_TP');            // (0.7-0.4)*10 = +3
      fire(auditA, 'c2', 0.5, 20);
      auditA.recordSettlement('c2', 0);                   // (0-0.5)*20 = -10
      const riskA = new RiskManager({}, 1000);
      riskA.recordTrade({ pnlUsd: 3, ts: Date.now(), side: 'BUY' });
      riskA.recordTrade({ pnlUsd: -60, ts: Date.now(), side: 'SELL' }); // daily halt
      expect(riskA.canTrade()).toBe(false);

      // ---- Restart: fresh store + fresh risk, same persisted files ----
      const auditB = new SignalAuditStore();
      auditB.replayJsonl(auditPath);
      const riskB = new RiskManager({}, 1000);
      riskB.loadPersistedState();

      // Runtime boot pattern: rebuild the P&L/streak snapshot from settled audit.
      let total = 0; let wins = 0; let losses = 0;
      for (const sig of auditB.getSettledSignals()) {
        if (typeof sig.realizedEdge !== 'number') continue;
        total += sig.realizedEdge;
        if (sig.realizedEdge >= 0) wins++; else losses++;
      }
      expect(auditB.getSettledSignals().length).toBe(2);
      expect(total).toBeCloseTo(-7, 8);       // +3 - 10
      expect(wins).toBe(1);
      expect(losses).toBe(1);
      // The daily-loss halt must survive the restart (bug class: audit replayed
      // but risk reset to zero → [edge] and [risk] disagreed after redeploy).
      expect(riskB.canTrade()).toBe(false);
      expect(riskB.snapshot().dailyPnl).toBeCloseTo(-57, 10);
    } finally {
      SignalAuditStore.enableJsonl('');
      RiskManager.enablePersistence('');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
