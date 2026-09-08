/**
 * tests for src/services/bot-metrics.ts
 */
import { describe, it, expect } from 'vitest';
import { BotMetrics, startMetricsServer, type FunnelStatsSnapshot } from './bot-metrics.js';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';

function snap(over: Partial<FunnelStatsSnapshot> = {}): FunnelStatsSnapshot {
  return {
    feedReceived: 1000,
    votesRecorded: 50,
    filtered: 40,
    filteredThin: 0,
    filteredStale: 35,
    quorumFired: 3,
    executed: 3,
    failed: 0,
    byReason: { drift: 5, bankroll: 2 },
    ...over,
  };
}

describe('BotMetrics.feedFunnel', () => {
  it('mirrors snapshot scalars into Prometheus counters with category labels', () => {
    const m = new BotMetrics();
    m.feedFunnel(snap({ firedCategory: 'crypto', firedSide: 'BUY' }));
    m.feedFunnel(snap({ firedCategory: 'crypto', firedSide: 'BUY' }));
    m.feedFunnel(snap({ firedCategory: 'sports', firedSide: 'SELL' }));
    const out = m.registry.toProm();
    expect(out).toContain('polyland_funnel_received_total{category="crypto"} 2000');
    expect(out).toContain('polyland_funnel_fired_total{category="crypto",tier="all",side="BUY"} 6');
    expect(out).toContain('polyland_funnel_executed_total{category="sports",tier="all",side="SELL"} 3');
  });
  it('attaches skip-reason counters per category', () => {
    const m = new BotMetrics();
    m.feedFunnel(snap({ firedCategory: 'crypto', byReason: { drift: 5, anti_sniper: 3 } }));
    const out = m.registry.toProm();
    expect(out).toContain('polyland_funnel_skipped_total{reason="drift",category="crypto"} 5');
    expect(out).toContain('polyland_funnel_skipped_total{reason="anti_sniper",category="crypto"} 3');
  });
});

describe('BotMetrics.observePnl', () => {
  it('exposes the loss-tail distribution that mean-only logging hides', () => {
    const m = new BotMetrics();
    // 3 wins at +0.20, 2 losses at -0.85 — the audit's 5m-crypto shape.
    [0.20, 0.20, 0.20, -0.85, -0.85].forEach((p) =>
      m.observePnl({ category: 'crypto', outcome: p >= 0 ? 'won' : 'lost', side: 'BUY', pnlPerShare: p }),
    );
    const out = m.registry.toProm();
    // Buckets: PNL_PER_SHARE = [-0.99, -0.85, -0.50, -0.20, -0.05, 0, 0.05, 0.20, 0.50, 0.85, 0.99].
    // Wins (p=0.20) land in le=0.20 (3) and cumulative up to +Inf (3).
    expect(out).toContain('polyland_pnl_per_share_bucket{category="crypto",outcome="won",side="BUY",le="0.2"} 3');
    expect(out).toContain('polyland_pnl_per_share_bucket{category="crypto",outcome="won",side="BUY",le="+Inf"} 3');
    // Losses (p=-0.85) land in le=-0.85 (2) but NOT le=-0.99 (-0.85 > -0.99)
    // — the bucket that exposes the loss tail the audit identified.
    expect(out).toContain('polyland_pnl_per_share_bucket{category="crypto",outcome="lost",side="BUY",le="-0.85"} 2');
    expect(out).toContain('polyland_pnl_per_share_bucket{category="crypto",outcome="lost",side="BUY",le="+Inf"} 2');
    expect(out).toContain('polyland_pnl_per_share_sum{category="crypto",outcome="lost",side="BUY"} -1.7');
    expect(out).toContain('polyland_pnl_per_share_count{category="crypto",outcome="lost",side="BUY"} 2');
  });
});

describe('BotMetrics.observeEntryPrice', () => {
  it('shows the audit 0.85 top-buy cluster', () => {
    const m = new BotMetrics();
    // Three entries at 0.85 (top-buy pattern), one at 0.50.
    [0.85, 0.85, 0.85, 0.50].forEach((p) => m.observeEntryPrice('crypto', 'PRIMARY', p));
    const out = m.registry.toProm();
    // Cumulative: le=0.5 catches the 0.50 alone (1), le=0.7 still 1, le=0.85
    // catches the three 0.85s AND the 0.50 (4), le=0.9 still 4, +Inf 4.
    expect(out).toContain('polyland_entry_price_bucket{category="crypto",tier="PRIMARY",le="0.5"} 1');
    expect(out).toContain('polyland_entry_price_bucket{category="crypto",tier="PRIMARY",le="0.7"} 1');
    expect(out).toContain('polyland_entry_price_bucket{category="crypto",tier="PRIMARY",le="0.85"} 4');
    expect(out).toContain('polyland_entry_price_bucket{category="crypto",tier="PRIMARY",le="+Inf"} 4');
  });
});

describe('BotMetrics gauges', () => {
  it('clamp bankroll utilization to [0,1]', () => {
    const m = new BotMetrics();
    m.setBankrollUtil('crypto', 1.5);
    // After the clamp, the value is 1. Use a separate gauge per assertion
    // to avoid the second-set race.
    expect(m.registry.toProm()).toContain('polyland_bankroll_utilization_ratio{category="crypto"} 1');
    const m2 = new BotMetrics();
    m2.setBankrollUtil('sports', -0.2);
    expect(m2.registry.toProm()).toContain('polyland_bankroll_utilization_ratio{category="sports"} 0');
  });
});

describe('startMetricsServer', () => {
  it('serves /metrics in Prometheus text-format', async () => {
    const m = new BotMetrics();
    m.feedFunnel(snap());
    const port = await pickFreePort();
    const server = startMetricsServer(m, port, '127.0.0.1');
    try {
      const body = await httpGet(`http://127.0.0.1:${port}/metrics`);
      expect(body).toContain('# TYPE polyland_funnel_received_total counter');
      expect(body).toContain('polyland_funnel_received_total{category="other"} 1000');
      // healthz works
      const health = await httpGet(`http://127.0.0.1:${port}/healthz`);
      expect(JSON.parse(health).ok).toBe(true);
    } finally {
      server.close();
    }
  });
});

// ---------- test helpers ----------

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const s = import('node:net').then((m) => m.createServer());
    s.then((srv) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).end();
  });
}
