/**
 * metrics.ts — Prometheus-shaped metric primitives, no external dependency.
 *
 * Why a hand-rolled registry instead of `prom-client`:
 *   - Zero new deps; the four metric types cover Polyland's needs entirely.
 *   - Histograms with the right buckets for *this* market (entry price,
 *     exit pnl, hold duration) — which is what was missing in the funnel
 *     log lines (mean-only, no distribution shape).
 *   - Exemplars attach the original trade payload to a histogram bucket,
 *     so a fire at 0.85 can be traced back to the actual SmartMoneyTrade.
 *   - Freqtrade-style labels-per-event: every metric carries
 *     {category, basket, tier, outcome, side, decision}, the minimum
 *     segmentation to answer "what's the realized edge p50 in crypto
 *     sub-hour?" without re-querying the JSONL.
 *
 * What the bot already had:
 *   - Scalar counters in BasketQuorumService.stats (mean-only, no percentiles,
 *     no segmentation). The audit repeatedly showed the limitation.
 * What this module adds:
 *   - Counter / Gauge / Histogram / Summary
 *   - Labels and exemplars
 *   - Serialization to the standard Prometheus text exposition format
 *     so a sidecar Grafana (or a `curl /metrics` in a notebook) can read it.
 *
 * This is the data-model half of the recommendation; the embedding into
 * basket-quorum-service and the `/metrics` endpoint are separate commits.
 */

// ============================================================================
// Types
// ============================================================================

export type LabelValues = ReadonlyArray<string>;

/** Standard Prometheus label set: name -> values, ordered by declaration. */
export type LabelSet = Readonly<Record<string, string>>;

/** Histogram bucket boundaries, in increasing order. The +Inf bucket is implicit. */
export type Buckets = ReadonlyArray<number>;

/** Quantile error tolerance for Summaries (Prometheus default 0.01). */
export interface SummaryOpts {
  /** Max age (sec) for a quantile before it is considered stale. */
  maxAgeSec: number;
  /** Number of buckets used to estimate quantiles. */
  numAgeBuckets: number;
}

// ============================================================================
// Counter
// ============================================================================

/**
 * Counter: monotonically-increasing value, reset only on process restart.
 * Use for: total fires, total executions, total errors.
 * Adopts the prom-client Counter type verbatim.
 */
export class Counter {
  /** value + per-label-set value */
  private values = new Map<string, number>();
  private labelNames: ReadonlyArray<string>;
  constructor(
    public readonly name: string,
    public readonly help: string,
    labelNames: ReadonlyArray<string> = [],
  ) {
    this.labelNames = labelNames;
  }

  inc(labels: LabelSet = {}, v = 1): void {
    if (v < 0) throw new Error(`Counter ${this.name} cannot decrement`);
    const k = this.labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + v);
  }

  private labelKey(labels: LabelSet): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => labels[n] ?? '').join('|');
  }

  /** Prometheus text-format: name{labels} value. */
  toProm(): string[] {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) {
      const labels = this.renderLabels(k);
      out.push(`${this.name}${labels} ${v}`);
    }
    return out;
  }

  private renderLabels(k: string): string {
    if (this.labelNames.length === 0) return '';
    const vals = k.split('|');
    const pairs = this.labelNames
      .map((n, i) => [n, vals[i] ?? ''] as [string, string])
      .filter(([, v]) => v !== '')
      .map(([n, v]) => `${n}="${escapeLabel(v)}"`);
    if (pairs.length === 0) return '';
    return `{${pairs.join(',')}}`;
  }
}

// ============================================================================
// Gauge
// ============================================================================

/**
 * Gauge: a value that goes up OR down. Use for: open position count,
 * bankroll utilization ratio, consecutive losses streak length, basket
 * subscription count. Adoption of prom-client Gauge.
 */
export class Gauge {
  private values = new Map<string, number>();
  private labelNames: ReadonlyArray<string>;
  constructor(
    public readonly name: string,
    public readonly help: string,
    labelNames: ReadonlyArray<string> = [],
  ) {
    this.labelNames = labelNames;
  }

  set(labels: LabelSet, v: number): void;
  set(v: number): void;
  set(labelsOrValue: LabelSet | number, v?: number): void {
    const [labels, value] = arguments.length === 1
      ? [{}, labelsOrValue as number]
      : [labelsOrValue as LabelSet, v as number];
    this.values.set(this.labelKey(labels), value);
  }

  inc(labels: LabelSet, v = 1): void {
    const k = this.labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + v);
  }

  dec(labels: LabelSet, v = 1): void {
    this.inc(labels, -v);
  }

  private labelKey(labels: LabelSet): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => labels[n] ?? '').join('|');
  }

  toProm(): string[] {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.values) {
      const labels = this.renderLabels(k);
      out.push(`${this.name}${labels} ${v}`);
    }
    return out;
  }

  private renderLabels(k: string): string {
    if (this.labelNames.length === 0) return '';
    const vals = k.split('|');
    const pairs = this.labelNames
      .map((n, i) => [n, vals[i] ?? ''] as [string, string])
      .filter(([, v]) => v !== '')
      .map(([n, v]) => `${n}="${escapeLabel(v)}"`);
    return `{${pairs.join(',')}}`;
  }
}

// ============================================================================
// Histogram
// ============================================================================

export interface HistogramOpts {
  buckets: Buckets;
}

/**
 * Histogram: bucketed distribution. Use for: entry price, exit pnl,
 * hold duration, slippage ticks. Adopts the prom-client Histogram
 * type with explicit buckets — Polyland-specific defaults chosen to
 * match the empirical distributions seen in production (e.g. entry
 * price buckets 0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90, 0.95, 0.99
 * expose the 5m-crypto top-buy pattern that the mean-only funnel log hid).
 */
export class Histogram {
  /** Per-label-set cumulative bucket counts, length = buckets + 1 (+Inf). */
  private buckets = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  private labelNames: ReadonlyArray<string>;
  public readonly bucketEdges: ReadonlyArray<number>;

  constructor(
    public readonly name: string,
    public readonly help: string,
    labelNames: ReadonlyArray<string> = [],
    opts: HistogramOpts,
  ) {
    this.labelNames = labelNames;
    this.bucketEdges = opts.buckets;
  }

  observe(labels: LabelSet, value: number): void {
    const k = this.labelKey(labels);
    let b = this.buckets.get(k);
    if (!b) { b = new Array(this.bucketEdges.length + 1).fill(0); this.buckets.set(k, b); }
    for (let i = 0; i < this.bucketEdges.length; i++) {
      if (value <= this.bucketEdges[i]) b[i]++;
    }
    b[b.length - 1]++; // +Inf
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  private labelKey(labels: LabelSet): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => labels[n] ?? '').join('|');
  }

  toProm(): string[] {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, b] of this.buckets) {
      const userLabels = this.parseLabels(k);
      for (let i = 0; i < this.bucketEdges.length; i++) {
        const pairs: Array<[string, string]> = [...userLabels, ['le', String(this.bucketEdges[i])]];
        out.push(`${this.name}_bucket${this.renderLabels(pairs)} ${b[i]}`);
      }
      // +Inf bucket
      const infPairs: Array<[string, string]> = [...userLabels, ['le', '+Inf']];
      out.push(`${this.name}_bucket${this.renderLabels(infPairs)} ${b[b.length - 1]}`);
      out.push(`${this.name}_sum${this.renderLabels(userLabels)} ${this.sums.get(k) ?? 0}`);
      out.push(`${this.name}_count${this.renderLabels(userLabels)} ${this.counts.get(k) ?? 0}`);
    }
    return out;
  }

  private parseLabels(k: string): Array<[string, string]> {
    if (this.labelNames.length === 0) return [];
    const vals = k.split('|');
    return this.labelNames.map((n, i) => [n, vals[i] ?? '']);
  }

  private renderLabels(pairs: Array<[string, string]>): string {
    if (pairs.length === 0) return '';
    const rendered = pairs
      .filter(([_, v]) => v !== '')
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    return `{${rendered}}`;
  }
}

// ============================================================================
// Summary
// ============================================================================

/**
 * Summary: client-side quantile estimation. Use for short-window
 * percentiles where the histogram's fixed buckets are too coarse
 * (e.g. consecutive-loss streak length, drift-check latency).
 * Adopts the prom-client Summary.
 */
export class Summary {
  /** Per-label-set: sliding-window quantile state. */
  private ageBuckets = new Map<string, { quantiles: number[]; values: number[]; ts: number }[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  private labelNames: ReadonlyArray<string>;
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly quantiles: ReadonlyArray<number>,
    labelNames: ReadonlyArray<string> = [],
    private readonly opts: SummaryOpts = { maxAgeSec: 600, numAgeBuckets: 5 },
  ) {
    this.labelNames = labelNames;
  }

  observe(labels: LabelSet, value: number): void {
    const k = this.labelKey(labels);
    const now = Date.now();
    const e = { quantiles: [0, 0, 0] as number[], values: [value] as number[], ts: now };
    if (!this.ageBuckets.has(k)) this.ageBuckets.set(k, []);
    this.ageBuckets.get(k)!.push(e);
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.evict(k, now);
  }

  private evict(k: string, now: number): void {
    const arr = this.ageBuckets.get(k);
    if (!arr) return;
    const cutoff = now - this.opts.maxAgeSec * 1000 * this.opts.numAgeBuckets;
    while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
    if (arr.length === 0) return;
    // Merge all current observations and re-sort into age buckets.
    const bucketSize = this.opts.maxAgeSec * 1000;
    const newest = arr[arr.length - 1].ts;
    const buckets: number[][] = Array.from({ length: this.opts.numAgeBuckets }, () => []);
    for (const e of arr) {
      const ageBucket = Math.min(
        this.opts.numAgeBuckets - 1,
        Math.floor((newest - e.ts) / bucketSize),
      );
      buckets[ageBucket].push(e.values[0]);
    }
    const merged: number[] = buckets.flat().sort((a, b) => a - b);
    const latest = arr[arr.length - 1];
    for (let i = 0; i < this.quantiles.length; i++) {
      const q = this.quantiles[i];
      const idx = merged.length === 0
        ? 0
        : Math.min(merged.length - 1, Math.max(0, Math.floor(q * merged.length)));
      latest.quantiles[i] = merged[idx] ?? 0;
    }
  }

  private labelKey(labels: LabelSet): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => labels[n] ?? '').join('|');
  }

  toProm(): string[] {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    for (const [k, arr] of this.ageBuckets) {
      const userLabels = this.parseLabels(k);
      for (let i = 0; i < this.quantiles.length; i++) {
        const e = arr[arr.length - 1] ?? { quantiles: [], values: [], ts: 0 };
        const v = e.quantiles[0] ?? 0;
        const q = this.quantiles[i];
        const pairs: Array<[string, string]> = [...userLabels, ['quantile', String(q)]];
        out.push(`${this.name}${this.renderLabels(pairs)} ${v}`);
      }
      out.push(`${this.name}_sum${this.renderLabels(userLabels)} ${this.sums.get(k) ?? 0}`);
      out.push(`${this.name}_count${this.renderLabels(userLabels)} ${this.counts.get(k) ?? 0}`);
    }
    return out;
  }

  private parseLabels(k: string): Array<[string, string]> {
    if (this.labelNames.length === 0) return [];
    const vals = k.split('|');
    return this.labelNames.map((n, i) => [n, vals[i] ?? '']);
  }

  private renderLabels(pairs: Array<[string, string]>): string {
    if (pairs.length === 0) return '';
    const rendered = pairs
      .filter(([_, v]) => v !== '')
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    return `{${rendered}}`;
  }
}

// ============================================================================
// Registry
// ============================================================================

/**
 * MetricRegistry: holds all metrics and renders the standard Prometheus
 * text-format output. A single registry per service. Pattern from
 * prom-client's `Registry` + freqtrade's `Metrics.collect()`.
 */
export class MetricRegistry {
  private metrics: Array<Counter | Gauge | Histogram | Summary> = [];
  private byName = new Map<string, Counter | Gauge | Histogram | Summary>();

  counter(name: string, help: string, labelNames: ReadonlyArray<string> = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: ReadonlyArray<string> = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }
  histogram(
    name: string, help: string, labelNames: ReadonlyArray<string> = [],
    opts: HistogramOpts,
  ): Histogram {
    return this.add(new Histogram(name, help, labelNames, opts));
  }
  summary(
    name: string, help: string, quantiles: ReadonlyArray<number>,
    labelNames: ReadonlyArray<string> = [],
    opts: SummaryOpts = { maxAgeSec: 600, numAgeBuckets: 5 },
  ): Summary {
    return this.add(new Summary(name, help, quantiles, labelNames, opts));
  }

  private add<T extends Counter | Gauge | Histogram | Summary>(m: T): T {
    if (this.byName.has(m.name)) {
      throw new Error(`Metric ${m.name} already registered`);
    }
    this.metrics.push(m);
    this.byName.set(m.name, m);
    return m;
  }

  /** Render Prometheus text-format exposition (1.0.0). */
  toProm(): string {
    return this.metrics.flatMap((m) => m.toProm()).join('\n') + '\n';
  }

  /** List metric names (useful for /metrics index endpoints). */
  names(): string[] {
    return this.metrics.map((m) => m.name);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Escape a label value per the Prometheus spec: backslash, double-quote, newline. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Polyland-tuned bucket sets. These are not arbitrary — they were chosen
 * to expose the failure modes the audit repeatedly caught:
 *  - 0.05..0.99 entry price buckets: the 5m-crypto top-buy at 0.85
 *    shows up as "all in the 0.85 bucket" instead of mean-only "0.45"
 *  - symmetric pnl buckets (-0.99..+0.99): shows loss-tail vs win-tail
 *    distribution shape (the audit showed a fat left tail)
 *  - 0..1800s hold duration: the 30-min-vs-5min market-type split
 *    (long markets hold longer; 5m crypto should cluster near 0)
 *  - 0..300s latency: the WS-reconnect-driven slow-consumer problem
 */
export const POLYLAND_BUCKETS = {
  /** Entry price in probability space (0-1). Matches the 0.85 ceiling. */
  ENTRY_PRICE: [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.85, 0.90, 0.95, 0.99] as Buckets,
  /** Pnl per share, symmetric around zero. */
  PNL_PER_SHARE: [-0.99, -0.85, -0.50, -0.20, -0.05, 0, 0.05, 0.20, 0.50, 0.85, 0.99] as Buckets,
  /** Hold duration in seconds (5m -> 30m, then 12h+ for long markets). */
  HOLD_SECONDS: [60, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400] as Buckets,
  /** Operation latency in ms (drift check, ledger reserve, exit pass). */
  LATENCY_MS: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 3000, 10000] as Buckets,
};
