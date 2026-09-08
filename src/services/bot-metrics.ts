/**
 * bot-metrics.ts — Prometheus-format metrics endpoint for the Polyland bot.
 *
 * Why: the in-memory `BasketQuorumService.stats` counters are scalar
 * sums — the audit repeatedly showed the mean-only `[edge]` log line
 * hides the 5m-crypto loss-tail (typical losses 60-95% of cost; means
 * smear bimodal win/loss distributions together). The metrics layer
 * here surfaces the same events as Prometheus histograms, so a
 * `curl /metrics | grep polyland_pnl_per_share_bucket` exposes the
 * distribution shape that the funnel log line cannot.
 *
 * Wire-in: the funnel snapshot at the end of every 5min interval calls
 * `feedFunnel(stats)` here, which mirrors the scalar counts into
 * `Counter`s and the realized PnL samples into the `pnl_per_share`
 * histogram. The /metrics endpoint is optional; if no `PROMETHEUS_PORT`
 * is set, the registry is built but never served.
 *
 * No new dependencies — uses Node's stdlib `http` and the in-house
 * `metrics.ts` module.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Counter, Gauge, Histogram, Summary, MetricRegistry, POLYLAND_BUCKETS } from './metrics.js';

// ============================================================================
// Type
// ============================================================================

export interface FunnelStatsSnapshot {
  feedReceived: number;
  votesRecorded: number;
  filtered: number;
  filteredThin: number;
  filteredStale: number;
  quorumFired: number;
  executed: number;
  failed: number;
  byReason: Record<string, number>;
  // signal-side (for edge histo)
  realizedEdgePerShare?: number;
  firedCategory?: string;
  firedSide?: 'BUY' | 'SELL';
}

// ============================================================================
// BotMetrics
// ============================================================================

export class BotMetrics {
  readonly registry = new MetricRegistry();
  // Funnel counters, with category segmentation where it matters.
  private readonly cReceived = this.registry.counter(
    'polyland_funnel_received_total',
    'Raw feed events received by the quorum handler',
    ['category'],
  );
  private readonly cFired = this.registry.counter(
    'polyland_funnel_fired_total',
    'Quorum fires (executed copy orders)',
    ['category', 'tier', 'side'],
  );
  private readonly cExecuted = this.registry.counter(
    'polyland_funnel_executed_total',
    'Successful order placements',
    ['category', 'tier', 'side'],
  );
  private readonly cFailed = this.registry.counter(
    'polyland_funnel_failed_total',
    'Order failures (bankroll, ledger, risk)',
    ['reason', 'category'],
  );
  private readonly cSkipped = this.registry.counter(
    'polyland_funnel_skipped_total',
    'Fires skipped at a pre-execution gate',
    ['reason', 'category'],
  );
  // Realized PnL per share — the histogram that exposes the loss tail.
  private readonly hPnlPerShare = this.registry.histogram(
    'polyland_pnl_per_share',
    'Realized PnL per share at exit/settlement, signed (-0.99 = full loss)',
    ['category', 'outcome', 'side'],
    { buckets: POLYLAND_BUCKETS.PNL_PER_SHARE },
  );
  // Entry price — shows whether the bot buys tops (the audit's 0.85 case).
  private readonly hEntryPrice = this.registry.histogram(
    'polyland_entry_price',
    'Entry price paid per share at fire time',
    ['category', 'tier'],
    { buckets: POLYLAND_BUCKETS.ENTRY_PRICE },
  );
  // Hold duration — 5m crypto vs 30m+ long markets distribution.
  private readonly hHoldSec = this.registry.histogram(
    'polyland_hold_seconds',
    'Time from fire to exit/settlement, in seconds',
    ['category', 'exitReason'],   // camelCase to match the other histograms' label style
    { buckets: POLYLAND_BUCKETS.HOLD_SECONDS },
  );
  // Operation latency — drift check, ledger reserve, exit pass. Sits
  // empty until instrumented; cheap to register now.
  private readonly hOpMs = this.registry.histogram(
    'polyland_op_ms',
    'Internal operation latency',
    ['op'],
    { buckets: POLYLAND_BUCKETS.LATENCY_MS },
  );
  // Live state gauges (sampled at scrape time).
  private readonly gOpen = this.registry.gauge('polyland_open_positions', 'Currently open positions');
  private readonly gBankrollUtil = this.registry.gauge(
    'polyland_bankroll_utilization_ratio',
    'Bankroll spent / limit, 0-1',
    ['category'],
  );
  private readonly gConsecLoss = this.registry.gauge(
    'polyland_consecutive_losses',
    'Consecutive losses (drives the streak halt)',
    ['category'],
  );
  // Summary: rolling pnl per category (last 10 min).
  private readonly sPnl10m = this.registry.summary(
    'polyland_pnl_10min_window',
    'Rolling PnL summary (10 min window)',
    [0.5, 0.95],
    ['category'],
  );

  /** Last-seen cumulative funnel snapshot, keyed by label-set (category/tier/side),
   *  used to emit per-interval DELTAS. Prometheus counters are monotonically
   *  increasing totals; feeding a lifetime cumulative value to `Counter.inc()`
   *  on every scrape would re-add the whole run each interval (the observed
   *  "/metrics inflation" bug). */
  private lastFunnelByKey = new Map<string, FunnelStatsSnapshot>();

  /**
   * Mirror a funnel snapshot into metrics. Called from the funnel log
   * path so we don't add a separate event hook.
   */
  feedFunnel(s: FunnelStatsSnapshot): void {
    const cat = s.firedCategory ?? 'other';
    const tier = 'all';
    const side = s.firedSide ?? 'BUY';
    const key = `${cat}|${tier}|${side}`;
    const prev = this.lastFunnelByKey.get(key);
    this.lastFunnelByKey.set(key, { ...s });
    // Reset detection: if a cumulative counter DECREASED (e.g. stats.reset()
    // on basket re-config), the new cumulative total is the delta from a fresh
    // zero baseline; otherwise emit `current - last`.
    const delta = (cur: number, key: keyof FunnelStatsSnapshot): number => {
      const last = prev === undefined ? 0 : (prev[key] as number);
      return cur >= last ? cur - last : cur;
    };
    this.cReceived.inc({ category: cat }, delta(s.feedReceived, 'feedReceived'));
    this.cFired.inc({ category: cat, tier, side }, delta(s.quorumFired, 'quorumFired'));
    this.cExecuted.inc({ category: cat, tier, side }, delta(s.executed, 'executed'));
    this.cFailed.inc({ reason: 'order', category: cat }, delta(s.failed, 'failed'));
    // antiSniperReasons is a cumulative per-reason map; emit per-reason deltas.
    if (s.byReason) {
      const prevReasons = (prev?.byReason ?? {}) as Record<string, number>;
      const reasons = new Set<string>([...Object.keys(prevReasons), ...Object.keys(s.byReason)]);
      for (const reason of reasons) {
        const cur = s.byReason[reason] ?? 0;
        const last = prevReasons[reason] ?? 0;
        const d = cur >= last ? cur - last : cur;
        if (d !== 0) this.cSkipped.inc({ reason, category: cat }, d);
      }
    }
  }

  /** Record a single fire with the entry price (for top-buy distribution). */
  observeEntryPrice(category: string, tier: string, entryPrice: number): void {
    this.hEntryPrice.observe({ category, tier }, entryPrice);
  }

  /** Record a settled or exited position's PnL. */
  observePnl(opts: {
    category: string; outcome: 'won' | 'lost' | 'pending';
    side: 'BUY' | 'SELL'; pnlPerShare: number;
  }): void {
    this.hPnlPerShare.observe(
      { category: opts.category, outcome: opts.outcome, side: opts.side },
      opts.pnlPerShare,
    );
  }

  observeHold(opts: {
    category: string; exitReason: string; holdSeconds: number;
  }): void {
    this.hHoldSec.observe(
      { category: opts.category, exitReason: opts.exitReason },
      opts.holdSeconds,
    );
  }

  observeOp(op: string, ms: number): void {
    this.hOpMs.observe({ op }, ms);
  }

  setOpenPositions(n: number): void { this.gOpen.set(n); }
  setBankrollUtil(category: string, ratio: number): void {
    this.gBankrollUtil.set({ category }, Math.max(0, Math.min(1, ratio)));
  }
  setConsecLosses(category: string, n: number): void {
    this.gConsecLoss.set({ category }, n);
  }
  observeRollingPnl(category: string, pnl: number): void {
    this.sPnl10m.observe({ category }, pnl);
  }
}

// ============================================================================
// HTTP endpoint (optional)
// ============================================================================

/**
 * Start a tiny HTTP server that exposes `/metrics` in Prometheus
 * text-format. Disabled if `PROMETHEUS_PORT` is unset.
 * Returns the server (so callers can stop it on shutdown) or null.
 */
export function startMetricsServer(
  metrics: BotMetrics,
  port: number,
  host = '0.0.0.0',
): import('node:http').Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/metrics' || req.url?.startsWith('/metrics?')) {
      const body = metrics.registry.toProm();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body).toString(),
      });
      res.end(body);
      return;
    }
    if (req.url === '/' || req.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        metrics: metrics.registry.names().length,
        ts: Date.now(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  server.listen(port, host);
  console.log(`[BotMetrics] /metrics serving on http://${host}:${port}/metrics`);
  return server;
}
