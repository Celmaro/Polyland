/**
 * Chainlink TWAP oracle unit tests.
 *
 * Note: We don't test the actual WebSocket connection here (would need
 * a mock WS server). We test the public logic (E18 parsing, evaluate
 * quality flags, snapshot construction) by directly manipulating the
 * oracle's private state via `_handleMessage` (test-only) and the
 * `connect()` method's no-op state.
 */

import { describe, it, expect } from 'vitest';
import {
  ChainlinkTwapOracle,
  RTDS_TWAP_TOPICS,
  CHAINLINK_E18,
} from './chainlink-twap-oracle.js';

describe('ChainlinkTwapOracle', () => {
  describe('constants', () => {
    it('RTDS_TWAP_TOPICS contains 30s and 60s topics', () => {
      expect(RTDS_TWAP_TOPICS[30]).toBe('crypto_prices_twap_thirty');
      expect(RTDS_TWAP_TOPICS[60]).toBe('crypto_prices_twap_sixty');
    });

    it('CHAINLINK_E18 is 1e18', () => {
      expect(CHAINLINK_E18).toBe(1_000_000_000_000_000_000n);
    });
  });

  describe('E18 parsing', () => {
    // Indirectly test by injecting messages through the public emit path
    // and observing getSnapshot().

    it('parses integer E18 value as decimal', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      // 50000 USD in E18 = 50000 * 1e18
      // Inject via the internal handler using a synthetic message
      const msg = JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'btc', value: '50000000000000000000000', timestamp: Date.now() },
      });
      // @ts-ignore - private method for tests
      oracle._handleMessage(Buffer.from(msg));
      const snap = oracle.getSnapshot('btc');
      expect(snap).not.toBeNull();
      expect(snap!.twap30s).toBeCloseTo(50000, 4);
      oracle.close();
    });

    it('parses plain decimal value as-is', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const msg = JSON.stringify({
        topic: 'crypto_prices_twap_sixty',
        payload: { symbol: 'eth', twap: '3500.50', timestamp: Date.now() },
      });
      // @ts-ignore - private method for tests
      oracle._handleMessage(Buffer.from(msg));
      const snap = oracle.getSnapshot('eth');
      expect(snap).not.toBeNull();
      expect(snap!.twap60s).toBe(3500.5);
      oracle.close();
    });
  });

  describe('evaluate()', () => {
    it('returns "missing" when no data has been seen', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const evalResult = oracle.evaluate('btc', 0.5, 'BUY');
      expect(evalResult.quality).toBe('missing');
      expect(evalResult.scoreMultiplier).toBe(0.7);
      oracle.close();
    });

    it('returns "stale" when last tick is too old', () => {
      const oracle = new ChainlinkTwapOracle({
        autoReconnect: false,
        maxStalenessMs: 1_000,
      });
      // Inject a tick 10 seconds ago
      const oldTs = Date.now() - 10_000;
      const msg = JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'btc', value: '50000000000000000000000', timestamp: oldTs },
      });
      // @ts-ignore - private method for tests
      oracle._handleMessage(Buffer.from(msg));
      const evalResult = oracle.evaluate('btc', 0.5, 'BUY');
      expect(evalResult.quality).toBe('stale');
      expect(evalResult.scoreMultiplier).toBe(0.5);
      oracle.close();
    });

    it('returns "fresh" + aligned=true for BUY with positive TWAP momentum', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const now = Date.now();
      // 30s = 50100, 60s = 50000 → +0.2% momentum (positive)
      const msg1 = JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'btc', value: '50100000000000000000000', timestamp: now },
      });
      const msg2 = JSON.stringify({
        topic: 'crypto_prices_twap_sixty',
        payload: { symbol: 'btc', value: '50000000000000000000000', timestamp: now },
      });
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg1));
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg2));
      const evalResult = oracle.evaluate('btc', 0.5, 'BUY');
      expect(evalResult.quality).toBe('fresh');
      expect(evalResult.aligned).toBe(true);
      expect(evalResult.scoreMultiplier).toBe(1.0);
      oracle.close();
    });

    it('returns "fresh" + aligned=false for BUY with negative TWAP momentum', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const now = Date.now();
      // 30s = 49900, 60s = 50000 → -0.2% momentum (negative)
      const msg1 = JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'btc', value: '49900000000000000000000', timestamp: now },
      });
      const msg2 = JSON.stringify({
        topic: 'crypto_prices_twap_sixty',
        payload: { symbol: 'btc', value: '50000000000000000000000', timestamp: now },
      });
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg1));
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg2));
      const evalResult = oracle.evaluate('btc', 0.5, 'BUY');
      expect(evalResult.quality).toBe('fresh');
      expect(evalResult.aligned).toBe(false);
      expect(evalResult.scoreMultiplier).toBe(0.5);
      expect(evalResult.reason).toMatch(/twap_momentum_down/);
      oracle.close();
    });

    it('SELL signal: aligned=false when momentum is up (we want down)', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const now = Date.now();
      const msg1 = JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'btc', value: '50200000000000000000000', timestamp: now },
      });
      const msg2 = JSON.stringify({
        topic: 'crypto_prices_twap_sixty',
        payload: { symbol: 'btc', value: '50000000000000000000000', timestamp: now },
      });
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg1));
      // @ts-ignore
      oracle._handleMessage(Buffer.from(msg2));
      const evalResult = oracle.evaluate('btc', 0.5, 'SELL');
      expect(evalResult.aligned).toBe(false);
      expect(evalResult.reason).toMatch(/twap_momentum_up/);
      oracle.close();
    });
  });

  describe('getSnapshot()', () => {
    it('returns null when no ticks', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      expect(oracle.getSnapshot('btc')).toBeNull();
      oracle.close();
    });

    it('returns snapshot with both 30s and 60s values', () => {
      const oracle = new ChainlinkTwapOracle({ autoReconnect: false });
      const now = Date.now();
      // @ts-ignore
      oracle._handleMessage(Buffer.from(JSON.stringify({
        topic: 'crypto_prices_twap_thirty',
        payload: { symbol: 'eth', value: '3500000000000000000000', timestamp: now },
      })));
      // @ts-ignore
      oracle._handleMessage(Buffer.from(JSON.stringify({
        topic: 'crypto_prices_twap_sixty',
        payload: { symbol: 'eth', value: '3495000000000000000000', timestamp: now },
      })));
      const snap = oracle.getSnapshot('eth', now);
      expect(snap).not.toBeNull();
      expect(snap!.twap30s).toBeCloseTo(3500, 4);
      expect(snap!.twap60s).toBeCloseTo(3495, 4);
      // Divergence = |3500 - 3495| / 3495 ≈ 0.00143
      expect(snap!.twap30s !== null && snap!.twap60s !== null).toBe(true);
      oracle.close();
    });
  });
});
