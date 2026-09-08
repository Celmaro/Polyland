/**
 * tests for the metrics hooks in basket-quorum-service — verify that
 * observeEntryPrice fires on every successful execution and
 * observePnl fires on every exit/settlement. These are the wire-in
 * tests for the Prometheus-shaped metrics surface; the actual
 * call-site behavior is exercised by the existing basket-quorum
 * tests, so these are focused.
 */
import { describe, it, expect, vi } from 'vitest';
import { BotMetrics } from './bot-metrics.js';

describe('BotMetrics hook contracts', () => {
  it('records entry price exactly once per fire (with category + tier labels)', () => {
    const m = new BotMetrics();
    const spy = vi.spyOn(m, 'observeEntryPrice');
    m.observeEntryPrice('crypto', 'PRIMARY', 0.85);
    m.observeEntryPrice('crypto', 'PRIMARY', 0.42);
    m.observeEntryPrice('sports', 'SATELLITE', 0.51);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 'crypto', 'PRIMARY', 0.85);
    expect(spy).toHaveBeenNthCalledWith(3, 'sports', 'SATELLITE', 0.51);
  });

  it('records PnL per share with the canonical outcome label (won|pending|lost)', () => {
    const m = new BotMetrics();
    m.observePnl({ category: 'crypto', outcome: 'won', side: 'BUY', pnlPerShare: 0.5 });
    m.observePnl({ category: 'crypto', outcome: 'lost', side: 'BUY', pnlPerShare: -0.85 });
    m.observePnl({ category: 'crypto', outcome: 'pending', side: 'SELL', pnlPerShare: 0 });
    const out = m.registry.toProm();
    expect(out).toContain('polyland_pnl_per_share_count{category="crypto",outcome="won",side="BUY"} 1');
    expect(out).toContain('polyland_pnl_per_share_count{category="crypto",outcome="lost",side="BUY"} 1');
    expect(out).toContain('polyland_pnl_per_share_count{category="crypto",outcome="pending",side="SELL"} 1');
  });

  it('records hold duration with category + canonical exit_reason labels', () => {
      const m = new BotMetrics();
      m.observeHold({ category: 'crypto', exitReason: 'ADVERSE_MOVE', holdSeconds: 14 });
      m.observeHold({ category: 'crypto', exitReason: 'VALUE_EXIT', holdSeconds: 35 });
      const out = m.registry.toProm();
      // P2 bounded-vocabulary canonicalization: uppercase runtime exit reasons
      // are folded into the lowercase canonical label set.
      expect(out).toContain('polyland_hold_seconds_count{category="crypto",exitReason="adverse_move"} 1');
      expect(out).toContain('polyland_hold_seconds_count{category="crypto",exitReason="value_exit"} 1');
      expect(out).not.toContain('ADVERSE_MOVE');
      expect(out).not.toContain('VALUE_EXIT');
    });
});
