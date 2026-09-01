/**
 * WalletIngestionService
 *
 * Two-source wallet ingestion for the basket-quorum bot.
 *
 *   1. MANUAL source
 *      Wallets the operator explicitly trusts. These come from:
 *        - env vars  (TARGET_WALLETS=0xabc,0xdef)
 *        - a JSON / CSV file (--wallets-file path/to/wallets.json)
 *        - chat-time additions via .addManual(address, label)
 *
 *      Manual wallets are tagged and ALWAYS pass through screening
 *      (the screening service flags them but never drops them).
 *
 *   2. AUTO source
 *      Top-N wallets per category from Polymarket leaderboards,
 *      pulled via WalletService.getLeaderboardByPeriod(...).
 *      Polled periodically (default 6h) so the universe refreshes.
 *
 *   Both sources converge into a single de-duplicated list of
 *   RawCandidate records, each tagged with its source(s). The
 *   downstream WalletScreeningService runs the same quality gate
 *   on every candidate regardless of where it came from.
 *
 *   ==== Wiring ====
 *     const ingestion = new WalletIngestionService(walletService, config);
 *     const screening = new WalletScreeningService(walletService);
 *     const basket    = new BasketQuorumService(tradingService, config.baskets);
 *
 *     // Boot: load manual + auto sources, screen, push to basket.
 *     const candidates = await ingestion.collect();
 *     const screened   = await screening.score(candidates);
 *     basket.seed(screened);
 *
 *     // Refresh: every 6h, repeat.
 *     setInterval(async () => {
 *       const fresh = await ingestion.collect();
 *       const s     = await screening.score(fresh);
 *       basket.seed(s);
 *     }, config.refreshIntervalMs);
 */

import type { WalletService, TimePeriod, LeaderboardSortBy, LeaderboardCategory } from './wallet-service.js';

// ============================================================================
// Manual-source file shapes (env file or --wallets-file)
// ============================================================================

export interface ManualWalletSpec {
  address: string;
  label?: string;
  /**
   * Operator's category hint for this wallet. Goes to the matching basket
   * (e.g. 'politics', 'crypto', 'sports'). The screening service may
   * OVERRIDE this if the wallet's actual trade history disagrees (e.g. a
   * trader you filed under politics turns out to only trade crypto) — set
   * `lockCategory: true` to force the operator's choice.
   */
  category?: string;
  /** When true, screening won't override the operator-supplied category */
  lockCategory?: boolean;
  /** Skip screening (operator asserts this wallet). Default false. */
  bypassScreening?: boolean;
}

export interface ManualWalletsFile {
  /** Optional version marker so future migrations can break loudly. */
  version?: number;
  wallets: ManualWalletSpec[];
}

// ============================================================================
// Auto-source config (which categories, how many)
// ============================================================================

export interface AutoSourceConfig {
  enabled: boolean;
  /** Period to rank by */
  period: TimePeriod;
  /** How many top wallets to fetch per category */
  topN: number;
  /** Categories to scan */
  categories: LeaderboardCategory[];
  /** How often to refresh in ms (default 6h) */
  refreshIntervalMs: number;
  /** Sort by PnL or volume */
  sortBy: LeaderboardSortBy;
}

export interface WalletIngestionConfig {
  /** Manual wallet list, can be empty */
  manual: ManualWalletSpec[];
  /** Optional path to a JSON file with more manual wallets (loaded on boot) */
  manualFilePath?: string;
  /** Comma-separated env var fallback (TARGET_WALLETS) */
  envVarName?: string;
  /** Auto leaderboard config */
  auto: AutoSourceConfig;
}

// ============================================================================
// Raw candidate (pre-screening)
// ============================================================================

export type WalletSource = 'manual' | 'auto' | 'both';

export interface RawCandidate {
  /** Lowercased address — the canonical key everywhere downstream */
  address: string;
  /** Where this candidate came from */
  source: WalletSource;
  /** Operator label, if manual */
  label?: string;
  /**
   * Category hint. Resolution order (later overrides earlier unless
   * `lockCategory` is true):
   *   1. operator-supplied `manual.category`
   *   2. auto-source `leaderboardCategory`
   *   3. inferred from activity by WalletScreeningService
   */
  hintCategory?: string;
  /** When true, screening won't override the operator-supplied category */
  lockCategory?: boolean;
  /** Category hint from leaderboard category (auto) or operator (manual) */
  leaderboardCategory?: LeaderboardCategory;
  /** Auto-source rank (1-based) — undefined for manual */
  autoRank?: number;
  /** Auto-source raw stats — used to avoid an extra fetch in screening */
  autoPnl?: number;
  autoVolume?: number;
  /** Operator-set: skip screening for this wallet */
  bypassScreening?: boolean;
}

// ============================================================================
// Service
// ============================================================================

export class WalletIngestionService {
  private walletService: WalletService;
  private config: WalletIngestionConfig;
  private manualList: ManualWalletSpec[];

  constructor(walletService: WalletService, config: WalletIngestionConfig) {
    this.walletService = walletService;
    this.config = config;
    this.manualList = [...config.manual];
  }

  // ---- Manual source -----------------------------------------------------

  /** Add a wallet at runtime (e.g. from a chat command). */
  addManual(spec: ManualWalletSpec): void {
    const addr = spec.address.toLowerCase();
    if (this.manualList.some((w) => w.address.toLowerCase() === addr)) return;
    this.manualList.push({ ...spec, address: addr });
  }

  removeManual(address: string): boolean {
    const addr = address.toLowerCase();
    const before = this.manualList.length;
    this.manualList = this.manualList.filter((w) => w.address.toLowerCase() !== addr);
    return this.manualList.length < before;
  }

  /** Load additional wallets from a JSON file. Useful for config-as-code. */
  async loadManualFile(path: string): Promise<number> {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as ManualWalletsFile;
    if (!Array.isArray(parsed.wallets)) {
      throw new Error(`wallets file at ${path} has no "wallets" array`);
    }
    let added = 0;
    for (const spec of parsed.wallets) {
      const before = this.manualList.length;
      this.addManual(spec);
      if (this.manualList.length > before) added++;
    }
    return added;
  }

  /** Load wallets from an env var (comma-separated addresses). */
  loadManualFromEnv(envVarName = 'TARGET_WALLETS'): number {
    const raw = process.env[envVarName];
    if (!raw) return 0;
    let added = 0;
    for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const before = this.manualList.length;
      this.addManual({ address: token });
      if (this.manualList.length > before) added++;
    }
    return added;
  }

  // ---- Auto source -------------------------------------------------------

  /**
   * Pull top-N wallets per category from the leaderboard.
   * Returns a flat array of RawCandidates (still un-deduped against manual).
   */
  async fetchAuto(): Promise<RawCandidate[]> {
    if (!this.config.auto.enabled) return [];

    const out: RawCandidate[] = [];
    for (const category of this.config.auto.categories) {
      try {
        const entries = await this.walletService.getLeaderboardByPeriod(
          this.config.auto.period,
          this.config.auto.topN,
          this.config.auto.sortBy,
          category
        );
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          out.push({
            address: e.address.toLowerCase(),
            source: 'auto',
            leaderboardCategory: category,
            autoRank: e.rank ?? i + 1,
            autoPnl: e.pnl,
            autoVolume: e.volume,
          });
        }
      } catch (err) {
        console.error(
          `[WalletIngestion] leaderboard fetch failed for ${category}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return out;
  }

  // ---- Converge ---------------------------------------------------------

  /**
   * Collect from BOTH sources and return a de-duplicated list of
   * RawCandidates, each tagged with which source(s) it came from.
   *
   * Manual candidates always win label/category on conflict.
   */
  async collect(): Promise<RawCandidate[]> {
    const manual: RawCandidate[] = this.manualList.map((m) => ({
      address: m.address.toLowerCase(),
      source: 'manual',
      label: m.label,
      // The operator's explicit category hint (lowercased to MarketCategory shape).
      // Stored as `hintCategory` so screening knows the priority order
      // (manual → auto → inferred).
      hintCategory: m.category?.toLowerCase(),
      lockCategory: m.lockCategory,
      // Keep `leaderboardCategory` populated too — it's the field the dedup
      // logic and the screening service treat as "auto-source signal".
      leaderboardCategory: m.category
        ? (m.category.toUpperCase() as LeaderboardCategory)
        : undefined,
      bypassScreening: m.bypassScreening,
    }));

    const auto = await this.fetchAuto();

    const byAddr = new Map<string, RawCandidate>();
    for (const m of manual) byAddr.set(m.address, m);
    for (const a of auto) {
      const existing = byAddr.get(a.address);
      if (!existing) {
        byAddr.set(a.address, a);
      } else {
        byAddr.set(a.address, {
          ...existing,
          source: 'both',
          autoRank: a.autoRank,
          autoPnl: a.autoPnl,
          autoVolume: a.autoVolume,
          leaderboardCategory: existing.leaderboardCategory ?? a.leaderboardCategory,
        });
      }
    }
    return [...byAddr.values()];
  }

  getConfig(): WalletIngestionConfig {
    return { ...this.config, manual: [...this.manualList] };
  }
}
