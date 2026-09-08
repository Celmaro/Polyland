/**
 * tests for src/services/metrics.ts — Prometheus-shaped primitives, no deps.
 */
import { describe, it, expect } from 'vitest';
import { Counter, Gauge, Histogram, Summary, MetricRegistry, POLYLAND_BUCKETS } from './metrics.js';

describe('Counter', () => {
  it('increments unlabeled by 1 by default', () => {
    const c = new Counter('test_total', 'test');
    c.inc();
    c.inc();
    c.inc();
    expect(c.toProm().join('\n')).toContain('test_total 3');
  });
  it('accumulates per label-set independently', () => {
    const c = new Counter('requests_total', 'help', ['method', 'status']);
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'POST', status: '500' });
    const out = c.toProm().join('\n');
    expect(out).toContain('requests_total{method="GET",status="200"} 2');
    expect(out).toContain('requests_total{method="POST",status="500"} 1');
  });
  it('rejects negative increments (monotonic invariant)', () => {
    const c = new Counter('m', 'h');
    expect(() => c.inc({}, -1)).toThrow();
  });
  it('emits HELP and TYPE lines in the Prometheus text format', () => {
    const c = new Counter('c', 'c help');
    c.inc();
    const out = c.toProm();
    expect(out[0]).toBe('# HELP c c help');
    expect(out[1]).toBe('# TYPE c counter');
  });
});

describe('Gauge', () => {
  it('set/inc/dec independently per label-set', () => {
    const g = new Gauge('consec_losses', 'h', ['basket']);
    g.set({ basket: 'sports' }, 3);
    g.inc({ basket: 'sports' });
    g.dec({ basket: 'crypto' }, 5);
    const out = g.toProm().join('\n');
    expect(out).toContain('consec_losses{basket="sports"} 4');
    expect(out).toContain('consec_losses{basket="crypto"} -5');
  });
  it('gauge accepts unlabeled set(value)', () => {
    const g = new Gauge('g', 'h');
    g.set(42);
    expect(g.toProm().join('\n')).toContain('g 42');
  });
});

describe('Histogram', () => {
  it('puts each observation into the right bucket + +Inf', () => {
    const h = new Histogram('entry_price', 'h', [], { buckets: [0.30, 0.50, 0.85, 0.99] });
    h.observe({}, 0.20); // bucket 0
    h.observe({}, 0.40); // bucket 1
    h.observe({}, 0.90); // bucket 2 (since 0.85, 0.99 < 0.90, goes to +Inf)
    h.observe({}, 0.10); // bucket 0
    const out = h.toProm().join('\n');
    // 4 observations: 2 <=0.30, 1 in 0.30-0.50, 1 in 0.50-0.85
    expect(out).toContain('entry_price_bucket{le="0.3"} 2');
    expect(out).toContain('entry_price_bucket{le="0.5"} 3');
    expect(out).toContain('entry_price_bucket{le="0.85"} 3');
    expect(out).toContain('entry_price_bucket{le="+Inf"} 4');
    expect(out).toContain('entry_price_sum 1.6');
    expect(out).toContain('entry_price_count 4');
  });
  it('exposes distribution shape that a mean-only counter cannot', () => {
    // 4 values: three 0.20 wins and one 0.95 loss. Mean = 0.3875.
    // The bucket distribution exposes the bimodality that a mean-only counter
    // would smear together: 3 in <=0.30 (wins cluster), 4 in <=0.95 (all 4
    // observations fit, including the loss tail). The +Inf bucket catches
    // everything, so a query that says "what fraction of crypto losses
    // have a per-share pnl > 0.50?" gets `1 - bucket{0.5}/bucket{+Inf}`.
    const h = new Histogram('pnl', 'h', [], { buckets: [0.30, 0.50, 0.95, 0.99] });
    [0.20, 0.20, 0.20, 0.95].forEach((v) => h.observe({}, v));
    const out = h.toProm().join('\n');
    // Cumulative: bucket le=0.3 has 3 (wins only); le=0.5 has 3 (wins only,
    // the 0.95 loss exceeds 0.5); le=0.95 has 4 (the 0.95 observation is
    // <= 0.95, so it lands in this bucket); le=0.99 has 4; +Inf has 4.
    expect(out).toContain('pnl_bucket{le="0.3"} 3');
    expect(out).toContain('pnl_bucket{le="0.5"} 3');
    expect(out).toContain('pnl_bucket{le="0.95"} 4');
    expect(out).toContain('pnl_bucket{le="0.99"} 4');
    expect(out).toContain('pnl_bucket{le="+Inf"} 4');
    expect(out).toContain('pnl_sum 1.55');
    expect(out).toContain('pnl_count 4');
  });
  it('segmentation by label-set is independent', () => {
    const h = new Histogram('exec_ms', 'h', ['side'], { buckets: [10, 50, 200] });
    h.observe({ side: 'BUY' }, 5);
    h.observe({ side: 'SELL' }, 100);
    const out = h.toProm().join('\n');
    // BUY 5ms: cumulative 1 in le=10, then 1 in +Inf
    expect(out).toContain('exec_ms_bucket{side="BUY",le="10"} 1');
    expect(out).toContain('exec_ms_bucket{side="BUY",le="50"} 1');
    expect(out).toContain('exec_ms_bucket{side="BUY",le="200"} 1');
    expect(out).toContain('exec_ms_bucket{side="BUY",le="+Inf"} 1');
    // SELL 100ms: 0 in le=10, 0 in le=50, 1 in le=200, 1 in +Inf
    expect(out).toContain('exec_ms_bucket{side="SELL",le="10"} 0');
    expect(out).toContain('exec_ms_bucket{side="SELL",le="50"} 0');
    expect(out).toContain('exec_ms_bucket{side="SELL",le="200"} 1');
    expect(out).toContain('exec_ms_bucket{side="SELL",le="+Inf"} 1');
  });
});

describe('Summary', () => {
  it('reports quantiles + sum + count', () => {
    const s = new Summary('streak', 'h', [0.5, 0.9, 0.99], [], { maxAgeSec: 600, numAgeBuckets: 1 });
    for (let i = 1; i <= 100; i++) s.observe({}, i);
    const out = s.toProm().join('\n');
    expect(out).toContain('streak{quantile="0.5"');
    expect(out).toContain('streak{quantile="0.9"');
    expect(out).toContain('streak{quantile="0.99"');
    expect(out).toContain('streak_sum');
    expect(out).toContain('streak_count 100');
  });
});

describe('MetricRegistry', () => {
  it('renders all metrics in Prometheus text-format with full exposition', () => {
    const reg = new MetricRegistry();
    const c = reg.counter('total_fires', 'fire count', ['category']);
    const h = reg.histogram('pnl_per_share', 'pnl dist', ['category'], { buckets: [-0.5, 0, 0.5] });
    c.inc({ category: 'crypto' });
    c.inc({ category: 'sports' });
    h.observe({ category: 'crypto' }, -0.3);
    h.observe({ category: 'crypto' }, 0.1);
    const out = reg.toProm();
    expect(out).toContain('# TYPE total_fires counter');
    expect(out).toContain('# TYPE pnl_per_share histogram');
    expect(out).toContain('total_fires{category="crypto"} 1');
    expect(out).toContain('total_fires{category="sports"} 1');
    expect(out).toContain('pnl_per_share_bucket{category="crypto",le="0"} 1');
    expect(out).toContain('pnl_per_share_bucket{category="crypto",le="+Inf"} 2');
  });
  it('rejects duplicate metric names (mirrors prom-client behavior)', () => {
    const reg = new MetricRegistry();
    reg.counter('dup', 'h');
    expect(() => reg.counter('dup', 'h')).toThrow();
  });
  it('exposes a name list for /metrics index', () => {
    const reg = new MetricRegistry();
    reg.counter('a', 'h');
    reg.gauge('b', 'h');
    reg.histogram('c', 'h', [], { buckets: [1] });
    reg.summary('d', 'h', [0.5]);
    expect(reg.names().sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('POLYLAND_BUCKETS', () => {
  it('exposes the four audit-derived bucket sets with sensible edges', () => {
    expect(POLYLAND_BUCKETS.ENTRY_PRICE).toContain(0.85);
    expect(POLYLAND_BUCKETS.PNL_PER_SHARE).toContain(0);
    expect(POLYLAND_BUCKETS.HOLD_SECONDS).toContain(300);
    expect(POLYLAND_BUCKETS.LATENCY_MS).toContain(50);
    // Each set must be strictly increasing.
    for (const [, buckets] of Object.entries(POLYLAND_BUCKETS)) {
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i]).toBeGreaterThan(buckets[i - 1]);
      }
    }
  });
});
