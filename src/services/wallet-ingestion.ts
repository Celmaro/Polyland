/**
 * Wallet ingestion (C1–C7): multi-source intake with corroboration, a registry
 * with a probation lifecycle, behavioral filters, topic profiles, and
 * discovery failure guards. Complements Polyland's CopyScore layer.
 */
export type WalletTier = 'WATCHLIST' | 'SATELLITE' | 'PRIMARY';
export type WalletStatus = 'active' | 'probation' | 'rejected' | 'removed';

export interface IngestCandidate {
  wallet: string;
  sources: string[];           // e.g. ['leaderboard','market_trades','curated']
  score: number;               // CopyScore (0-1)
  tier?: WalletTier;
  category: string;
  tradeCount: number;
  weeklyTrades: number;
  peakTrades60s: number;
  realizedPnl: number;
}

export interface WalletRecord {
  wallet: string;
  sourceRef: string;
  status: WalletStatus;
  tier: WalletTier;
  statusReason: string;
  firstSeen: number;
  lastScored: number;
  score: number;
  category: string;
}

export interface IngestConfig {
  minScorePromotion: number;
  minTradesPromotion: number;
  maxWeeklyTrades?: number;
  maxBurst60s?: number;
}

/** C1 — bonus when a wallet is corroborated by multiple independent sources. */
export function corroborationBonus(sources: string[]): number {
  const distinct = new Set(sources).size;
  if (distinct < 2) return 0;
  return Math.min(0.15, 0.05 * (distinct - 1));
}

/** C6 — EVM address validation. */
export function verifyEVMAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/** C6 — abort a discovery run when the fetch-failure ratio is too high. */
export function discoveryHealthy(params: { attempted: number; failed: number }): boolean {
  const { attempted, failed } = params;
  if (attempted <= 0) return true;
  return failed / attempted < 0.5;
}

/** C5 — topic-affinity profile + specialization (HHI of topic concentration). */
export function buildTopicProfile(tradeCountsByTopic: Record<string, number>): {
  affinities: Record<string, number>;
  primaryTopic: string;
  specialization: number;
} {
  const total = Object.values(tradeCountsByTopic).reduce((s, v) => s + v, 0);
  if (total <= 0) return { affinities: {}, primaryTopic: 'other', specialization: 0 };
  const affinities: Record<string, number> = {};
  let primaryTopic = 'other';
  let primaryCount = -1;
  let specialization = 0;
  for (const [topic, count] of Object.entries(tradeCountsByTopic)) {
    const ratio = count / total;
    affinities[topic] = ratio;
    specialization += ratio * ratio;
    if (count > primaryCount) { primaryCount = count; primaryTopic = topic; }
  }
  return { affinities, primaryTopic, specialization };
}

/** C2/C3/C4 — wallet registry with a probation lifecycle. */
export class WalletIngestor {
  private records = new Map<string, WalletRecord>();
  private saveCallback: ((records: WalletRecord[]) => void) | null = null;

  constructor(private readonly config: IngestConfig) {}

  onSave(cb: (records: WalletRecord[]) => void): void {
    this.saveCallback = cb;
  }

  restore(records: WalletRecord[]): void {
    this.records.clear();
    for (const r of records) this.records.set(r.wallet.toLowerCase(), { ...r });
  }

  snapshot(): WalletRecord[] {
    return [...this.records.values()].sort((a, b) => a.wallet.localeCompare(b.wallet));
  }

  get(wallet: string): WalletRecord | undefined {
    return this.records.get(wallet.toLowerCase());
  }

  /** Register or re-score a candidate; applies behavioral filters + promotion. */
  register(c: IngestCandidate): WalletRecord {
    const now = Date.now();
    const wallet = c.wallet.toLowerCase();
    const existing = this.records.get(wallet);
    const bonus = corroborationBonus(c.sources);
    const effectiveScore = Math.min(1, c.score + bonus);

    // C4 — behavioral ingestion filters (bots / wash traders).
    if (this.config.maxBurst60s !== undefined && c.peakTrades60s > this.config.maxBurst60s) {
      const rec: WalletRecord = {
        wallet, sourceRef: c.sources.join('|'), status: 'rejected', tier: 'WATCHLIST',
        statusReason: `burst_peak_60s ${c.peakTrades60s} > ${this.config.maxBurst60s}`,
        firstSeen: existing?.firstSeen ?? now, lastScored: now, score: effectiveScore, category: c.category,
      };
      this.records.set(wallet, rec); this.persist(); return rec;
    }
    if (this.config.maxWeeklyTrades !== undefined && c.weeklyTrades > this.config.maxWeeklyTrades) {
      const rec: WalletRecord = {
        wallet, sourceRef: c.sources.join('|'), status: 'rejected', tier: 'WATCHLIST',
        statusReason: `frequency_cap_weekly ${c.weeklyTrades} > ${this.config.maxWeeklyTrades}`,
        firstSeen: existing?.firstSeen ?? now, lastScored: now, score: effectiveScore, category: c.category,
      };
      this.records.set(wallet, rec); this.persist(); return rec;
    }

    // C2/C3 — two-stage entry: probation until sample + score clear.
    const promoted = c.tradeCount >= this.config.minTradesPromotion && effectiveScore >= this.config.minScorePromotion;
    const status: WalletStatus = promoted ? 'active' : 'probation';
    const tier: WalletTier = promoted
      ? (effectiveScore >= this.config.minScorePromotion + 0.15 ? 'PRIMARY' : 'SATELLITE')
      : 'WATCHLIST';
    const rec: WalletRecord = {
      wallet,
      sourceRef: c.sources.join('|'),
      status,
      tier,
      statusReason: promoted
        ? `promoted sample=${c.tradeCount} score=${effectiveScore.toFixed(2)}`
        : `probation sample=${c.tradeCount} score=${effectiveScore.toFixed(2)} (need ${this.config.minTradesPromotion}/${this.config.minScorePromotion})`,
      firstSeen: existing?.firstSeen ?? now,
      lastScored: now,
      score: effectiveScore,
      category: c.category,
    };
    this.records.set(wallet, rec);
    this.persist();
    return rec;
  }

  private persist(): void {
    this.saveCallback?.(this.snapshot());
  }
}
