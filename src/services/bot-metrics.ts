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

export const LABEL_VOCABULARY = {
  category: ['crypto', 'politics', 'sports', 'football', 'basketball', 'tennis', 'motorsports', 'boxing_ufc', 'esports', 'baseball', 'cricket', 'entertainment', 'economics', 'science', 'other'],
  outcome: ['won', 'lost', 'pending'],
  side: ['BUY', 'SELL'],
  tier: ['PRIMARY', 'SATELLITE', 'WATCHLIST', 'all'],
  exitReason: ['value_exit', 'adverse_move', 'leader_exit', 'risk_exit', 'risk_halt', 'resolution', 'manual', 'unknown', 'other'],
  reason: ['drift', 'bankroll', 'edge', 'min_size', 'liquidity', 'risk', 'cooldown', 'anti_sniper', 'twap_stale', 'twap_misaligned', 'thin_liquidity', 'negative_edge', 'order', 'other'],
  op: ['drift_check', 'reserve', 'exit_pass', 'reconcile', 'other'],
} as const;

/** Map runtime label values to a bounded vocabulary before exposition. */
export function normalizeMetricLabel(value: string, vocabulary: readonly string[]): string {
  const raw = String(value ?? '');
  const exact = vocabulary.find((candidate) => candidate === raw);
  if (exact) return exact;
  const folded = raw.toLowerCase();
  const insensitive = vocabulary.find((candidate) => candidate.toLowerCase() === folded);
  return insensitive ?? 'other';
}

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
  // Audit 09-09 skip taxonomy (fail-closed gates counted separately from
  // real order failures) + quorum near-miss rollups.
  skippedStaleQuote?: number;
  skippedFeedStale?: number;
  skippedQuality?: number;
  nearMissInd?: number;
  nearMissCons?: number;
  nearMissExec?: number;
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
  // Fail-closed execution gates + quorum near-miss rollups (audit 09-09):
  // these used to vanish into stats.failed; now each is its own counter.
  private readonly cExecGate = this.registry.counter(
    'polyland_funnel_exec_gate_total',
    'Fail-closed execution gates by gate type',
    ['gate', 'category'],
  );
  private readonly cNearMiss = this.registry.counter(
    'polyland_funnel_near_miss_total',
    'Quorum reached but blocked at a downstream gate',
    ['gate', 'category'],
  );
  private readonly cLabelViolations = this.registry.counter(
    'polyland_metric_label_violations_total',
    'Metric label values normalized to the bounded other bucket',
    ['label'],
  );

  // Stale-quote cancellations and feed-lag (P1 observability).
  private readonly cStaleQuote = this.registry.counter(
    'polyland_stale_quote_cancellations_total',
    'Executions cancelled because the consensus quote was stale (fail-closed)',
  );
  private readonly gFeedLag = this.registry.gauge(
    'polyland_feed_lag_seconds',
    'Age of the newest processed feed event, seconds',
  );
  // Book integrity / queue pressure (P1 observability) — fed from the
  // ClobMarketWs integrity snapshot; bounded cardinality (no labels).
  private readonly gQueueBytes = this.registry.gauge(
    'polyland_queue_backpressure_bytes',
    'WebSocket bufferedAmount, bytes',
  );
  private readonly gQueuePressure = this.registry.gauge(
    'polyland_queue_backpressure',
    'True (1) when WS bufferedAmount exceeds the backpressure threshold',
  );
  private readonly cSeqGaps = this.registry.counter(
    'polyland_book_sequence_gaps_total',
    'Order-book sequence gaps detected (feed integrity)',
  );
  private readonly cResyncs = this.registry.counter(
    'polyland_book_resyncs_total',
    'Order-book resynchronizations requested',
  );
  private readonly cInvalidBooks = this.registry.counter(
    'polyland_book_invalidations_total',
    'Order-book invalidations',
  );
  private readonly cWsReconnects = this.registry.counter(
    'polyland_clob_reconnects_total',
    'CLOB WebSocket reconnects',
  );
  private readonly cWsQuarantine = this.registry.counter(
    'polyland_clob_quarantined_frames_total',
    'CLOB frames quarantined for parse/schema drift',
    ['reason'],
  );
  private readonly gWsOutageHalted = this.registry.gauge(
    'polyland_clob_outage_halted',
    'CLOB feed outage exceeded the execution halt threshold',
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
  private readonly hOpSec = this.registry.histogram(
    'polyland_operation_duration_seconds',
    'Internal operation latency in seconds',
    ['op'],
    { buckets: POLYLAND_BUCKETS.LATENCY_SECONDS },
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
  private label(name: keyof typeof LABEL_VOCABULARY, value: string): string {
    const normalized = normalizeMetricLabel(value, LABEL_VOCABULARY[name]);
    if (normalized === 'other' && value.toLowerCase() !== 'other') {
      this.cLabelViolations.inc({ label: name });
    }
    return normalized;
  }

  feedFunnel(s: FunnelStatsSnapshot): void {
    const cat = this.label('category', s.firedCategory ?? 'other');
    const tier = this.label('tier', 'all');
    const side = this.label('side', s.firedSide ?? 'BUY');
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
        if (d !== 0) this.cSkipped.inc({ reason: this.label('reason', reason), category: cat }, d);
      }
    }
    // Dedicated counters make fail-closed execution gates and quorum
    // near-misses visible instead of inflating `failed`.
    const gateDeltas: Array<[string, number | undefined]> = [
      ['stale_quote', s.skippedStaleQuote],
      ['feed_stale', s.skippedFeedStale],
      ['quality', s.skippedQuality],
    ];
    const previous = prev ?? {};
    for (const [gate, value] of gateDeltas) {
      const d = delta(value ?? 0, gate as keyof FunnelStatsSnapshot);
      if (d) this.cExecGate.inc({ gate, category: cat }, d);
    }
    const nearDeltas: Array<[string, number | undefined]> = [
      ['independence', s.nearMissInd],
      ['consensus', s.nearMissCons],
      ['execution', s.nearMissExec],
    ];
    for (const [gate, value] of nearDeltas) {
      const d = delta(value ?? 0, gate as keyof FunnelStatsSnapshot);
      if (d) this.cNearMiss.inc({ gate, category: cat }, d);
    }
  }

  /** Record a single fire with the entry price (for top-buy distribution). */
  observeEntryPrice(category: string, tier: string, entryPrice: number): void {
    this.hEntryPrice.observe({ category: this.label('category', category), tier: this.label('tier', tier) }, entryPrice);
  }

  /** Record a settled or exited position's PnL. */
  observePnl(opts: {
    category: string; outcome: 'won' | 'lost' | 'pending';
    side: 'BUY' | 'SELL'; pnlPerShare: number;
  }): void {
    this.hPnlPerShare.observe(
      { category: this.label('category', opts.category), outcome: this.label('outcome', opts.outcome), side: this.label('side', opts.side) },
      opts.pnlPerShare,
    );
  }

  observeHold(opts: {
    category: string; exitReason: string; holdSeconds: number;
  }): void {
    this.hHoldSec.observe(
      { category: this.label('category', opts.category), exitReason: this.label('exitReason', opts.exitReason) },
      opts.holdSeconds,
    );
  }

  observeOp(op: string, seconds: number): void {
    this.hOpSec.observe({ op: this.label('op', op) }, seconds);
  }

  setOpenPositions(n: number): void { this.gOpen.set(n); }

  /** A stale consensus quote was cancelled (execution-level fail-closed). */
  staleQuoteCancelled(): void { this.cStaleQuote.inc(); }
  /** Update the feed-lag gauge (seconds since newest processed event). */
  setFeedLagSeconds(ageSec: number): void { this.gFeedLag.set(Number.isFinite(ageSec) ? Math.max(0, ageSec) : 0); }

  setQueueBackpressureBytes(bytes: number): void { this.gQueueBytes.set(Math.max(0, bytes)); }
  setQueueBackpressure(on: boolean): void { this.gQueuePressure.set(on ? 1 : 0); }
  recordBookSequenceGap(): void { this.cSeqGaps.inc(); }
  recordBookResync(): void { this.cResyncs.inc(); }
  recordInvalidBook(): void { this.cInvalidBooks.inc(); }
  /** Mirror the CLOB WebSocket integrity snapshot (bounded, no labels). */
  mirrorClobIntegrity(state: { bufferedAmount: number; backpressure: boolean; sequenceGaps: number; resyncs: number; invalidBooks: number; connectionState?: string; outageHalted?: boolean; quarantinedFrames?: number; quarantineByReason?: Record<string, number> }): void {
    this.gQueueBytes.set(Math.max(0, state.bufferedAmount));
    this.gQueuePressure.set(state.backpressure ? 1 : 0);
    this.gWsOutageHalted.set(state.outageHalted ? 1 : 0);
    if (state.sequenceGaps > 0) this.cSeqGaps.inc({}, state.sequenceGaps);
    if (state.resyncs > 0) this.cResyncs.inc({}, state.resyncs);
    if (state.invalidBooks > 0) this.cInvalidBooks.inc({}, state.invalidBooks);
    if (state.quarantineByReason) {
      for (const [reason, n] of Object.entries(state.quarantineByReason)) {
        if (n > 0) this.cWsQuarantine.inc({ reason: this.label('reason', reason) }, n);
      }
    }
  }
  setBankrollUtil(category: string, ratio: number): void {
    this.gBankrollUtil.set({ category: this.label('category', category) }, Math.max(0, Math.min(1, ratio)));
  }
  setConsecLosses(category: string, n: number): void {
    this.gConsecLoss.set({ category: this.label('category', category) }, n);
  }
  observeRollingPnl(category: string, pnl: number): void {
    this.sPnl10m.observe({ category: this.label('category', category) }, pnl);
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
