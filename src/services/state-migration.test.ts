import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateStore } from './state-store.js';
import { VoteStateStore } from './vote-state-store.js';
import { RiskManager } from './risk-manager.js';

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
