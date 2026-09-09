/** Lifecycle coordinator for the production Polyland pipeline. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { PolymarketSDK } from '../index.js';
import { BasketQuorumService, type BasketQuorumConfig, type QuorumStats } from './basket-quorum-service.js';
import { WalletIngestionService } from './wallet-ingestion-service.js';
import { WalletScreeningService } from './wallet-screening-service.js';
import { VoteStateStore } from './vote-state-store.js';
import { RiskManager } from './risk-manager.js';
import { createStateStore } from './sqlite-state-store.js';
import { signalAuditStore, SignalAuditStore, setBonferroniGroups } from './signal-audit-store.js';
import { AntiSniperGuard } from '../utils/anti-sniper.js';
import { ChainlinkTwapOracle } from './chainlink-twap-oracle.js';
import { ClobMarketWsService } from './clob-market-ws.js';
import { reconcileDryRunOrders } from './reconciliation.js';
import type { OrderLifecycleRecord } from './state-store.js';
import { GammaResolutionPoller } from './gamma-resolution-poller.js';
import type { SmartMoneyTrade } from './smart-money-service.js';
import { TradeDetector, FileSeenTradeLedger } from './trade-detector.js';
import { DecisionLedger } from './decision-ledger.js';
import { computeGoLiveReport, DEFAULT_GO_LIVE_CRITERIA, formatGoLiveReport, type GoLiveReport } from './go-live-gate.js';
import { MarketQualityTracker } from './market-quality.js';
import { MarketSnapshotStore } from './market-snapshot-store.js';
export interface PolylandRuntimeConfig {
  dryRun: boolean;
  capital: { totalUsd: number };
  risk: Record<string, number | boolean>;
  smartMoney: { enabled: boolean; topN: number; customWallets: string[] };
  /** Optional: BotMetrics instance for parallel Prometheus surface. */
  botMetrics?: import('./bot-metrics.js').BotMetrics | null;
  independence?: { maxHHI: number; minNEffective: number; clusterThreshold?: number; consensusStrengthPrimary?: number; consensusStrengthSatellite?: number; capPerWallet?: number };
  basketRisk?: import('./basket-risk.js').BasketRiskConfig;
  paperExploration?: boolean;
}
export interface RuntimeStateSnapshot { startTime: number; dailyPnL: number; totalPnL: number; monthlyPnL: number; consecutiveLosses: number; consecutiveWins: number; currentCapital: number; peakCapital: number; currentDrawdown: number; permanentlyHalted: boolean; isPaused: boolean; reconciled: boolean; }
type ScreeningConfig = Record<string, unknown>;
export class PolylandRuntime {
  private quorum: BasketQuorumService | null = null;
  private ledger: DecisionLedger | null = null;
  private risk: RiskManager | null = null;
  private stateStore: any = null;
  private tradeSub: { unsubscribe: () => void } | null = null;
  private tradeDetector: TradeDetector | null = null;
  private tradeSeen: FileSeenTradeLedger | null = null;
  private gamma: GammaResolutionPoller | null = null;
  private clob: ClobMarketWsService | null = null;
  /** P1 lens #1/#3: market-quality tracker fed by CLOB mids. */
  private marketQuality: MarketQualityTracker | null = null;
  /** P1 lens #4: bucketed feature snapshots for replay/gating. */
  private marketSnapshots: MarketSnapshotStore | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private funnelTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private readonly startedAt = Date.now();
  private readonly snapshot: RuntimeStateSnapshot;
  constructor(private readonly sdk: PolymarketSDK, private readonly config: PolylandRuntimeConfig, private readonly screeningConfig: ScreeningConfig, private readonly quorumConfig: BasketQuorumConfig, private readonly onSettledTrade?: (pnl: number) => void) {
    this.snapshot = { startTime: this.startedAt, dailyPnL: 0, totalPnL: 0, monthlyPnL: 0, consecutiveLosses: 0, consecutiveWins: 0, currentCapital: config.capital.totalUsd, peakCapital: config.capital.totalUsd, currentDrawdown: 0, permanentlyHalted: false, isPaused: false, reconciled: false };
  }
  async start(): Promise<void> {
    if (!this.config.smartMoney.enabled) return;
    const ingestion = new WalletIngestionService(this.sdk.wallets, { manual: this.config.smartMoney.customWallets.map(address => ({ address, label: 'manual', source: 'manual' as const, lockCategory: false })), auto: { enabled: true, period: 'week', topN: this.config.smartMoney.topN, categories: ['OVERALL','CRYPTO','SPORTS','POLITICS','CULTURE','TECH','FINANCE','ECONOMICS'], refreshIntervalMs: 6 * 60 * 60 * 1000, sortBy: 'pnl' } });
    const screening = new WalletScreeningService(this.sdk.wallets, this.screeningConfig as any);
    const votes = new VoteStateStore('./data/quorum-state.json');
    const made = await createStateStore('./data/polyland-state.sqlite', './data/polyland-state.json');
    this.stateStore = made.store;
    const riskConfig = { dailyMaxLossPct: 0.05, monthlyMaxLossPct: 0.15, maxDrawdownFromPeak: 0.25, totalMaxLossPct: 0.40, lossSizingReduction: 0.20, winSizingIncrease: 0.10, enableDynamicSizing: true, ...this.config.risk } as any;
    this.risk = new RiskManager(riskConfig, this.config.capital.totalUsd);
        RiskManager.enablePersistence('./data/risk-state.json'); this.risk.loadPersistedState(); this.risk.setStateStore(this.stateStore);
        // P22 (pmxt auth pattern): never enter LIVE mode with an ambiguous wallet
        // configuration. Signature discovery must be EXPLICIT, never a silent
        // EOA/Gnosis fallback. Only enforced when trading for real.
        if (!this.config.dryRun) {
          const { assertValidWalletConfig } = await import('./wallet-signature-check.js');
          assertValidWalletConfig({
            signerAddress: process.env.SIGNER_ADDRESS,
            funderAddress: process.env.FUNDER_ADDRESS,
            signatureType: process.env.SIGNATURE_TYPE !== undefined ? Number(process.env.SIGNATURE_TYPE) : undefined,
            proxyAddress: process.env.PROXY_ADDRESS,
            chainId: process.env.CHAIN_ID !== undefined ? Number(process.env.CHAIN_ID) : 137,
          });
          console.log('[PolylandRuntime] live wallet config validated (signer/funder/signature-type explicit)');
        }
    SignalAuditStore.enableJsonl('./data/signal-audit.jsonl'); signalAuditStore.setStateStore(this.stateStore); signalAuditStore.replayJsonl('./data/signal-audit.jsonl');
    this.rebuildSnapshotFromAudit();
    this.ledger = new DecisionLedger();
    const ledgerRecords = await this.ledger.start();
    console.log(`[PolylandRuntime] decision ledger replayed ${ledgerRecords.length} records`);
    // Wire the trade detector to a REAL durable ledger. The previous stub
    // (claim always true, get always undefined) disabled identity dedup in
    // production, letting every replayed/reconnect fill flood votes (audit:
    // received=427k, 99% stale). Persisted to trade-seen.jsonl, loaded at boot.
    this.tradeSeen = new FileSeenTradeLedger('./data/trade-seen.jsonl');
    this.tradeSeen.start();
    this.tradeDetector = new TradeDetector(this.tradeSeen, { minNotional: 1 });
    this.quorum = new BasketQuorumService(this.sdk.tradingService, this.quorumConfig); this.quorum.setRiskManager(this.risk); if (this.config.botMetrics) this.quorum.setBotMetrics(this.config.botMetrics); if (this.config.independence) this.quorum.setIndependenceSettings(this.config.independence); if (this.config.basketRisk) this.quorum.setBasketRiskConfig(this.config.basketRisk); this.quorum.setPaperExplorationMode(this.config.paperExploration ?? false); this.quorum.setGammaApi(this.sdk.gammaApi); this.quorum.setDecisionLedger(this.ledger); this.quorum.setSpecializationThresholds(Number(this.screeningConfig.minCategoryTrades ?? 3), Number(this.screeningConfig.minCategoryWinRate ?? 0.58)); this.quorum.startExitLadder(); this.quorum.onSettledTrade = p => { this.recordSettled(p); this.onSettledTrade?.(p); };
    // P1 lens #1/#4: wire the market-quality tracker (chop/spread/depth gates)
    // and the bucketed feature-snapshot store. Both are optional — a throw
    // here must not prevent the bot from booting.
    try {
      this.marketQuality = new MarketQualityTracker();
      this.marketSnapshots = new MarketSnapshotStore('./data/market-ticks.sqlite');
      this.quorum.setMarketQuality(this.marketQuality);
      this.quorum.setMarketSnapshots(this.marketSnapshots);
    } catch (err) {
      console.warn('[PolylandRuntime] market-quality wiring failed (continuing without):', err instanceof Error ? err.message : err);
    }
    if (process.env.ANTI_SNIPER_ENABLED === 'true') this.quorum.setAntiSniper(new AntiSniperGuard(null));
    // ---- P0-5/P0-7: restart recovery + reconciliation gate ----
    // Restore open positions from the durable snapshot so the exit ladder
    // resumes them, then reconcile durable order records. Copy decisions stay
    // blocked (no baskets seeded, execution gate armed) until reconciliation
    // succeeds — the audit's settled-vs-risk restart desync bug class.
    this.quorum.onPositionsSnapshot = (records) => {
      void this.stateStore?.save({ positions: records as never }).catch((err: unknown) => {
        console.warn('[PolylandRuntime] positions snapshot persist failed:', err instanceof Error ? err.message : err);
      });
    };
    const persistedState = await this.stateStore.load();
    const restoredPositions = (Array.isArray(persistedState?.positions) ? persistedState.positions : []) as Array<Record<string, unknown>>;
    this.quorum.restoreOpenPositions(restoredPositions as never[]);
    const orders = (Array.isArray(persistedState?.orders) ? persistedState.orders : []) as OrderLifecycleRecord[];
    const reconciliation = reconcileDryRunOrders({
      orders,
      positionIds: new Set(restoredPositions.map((p) => String((p as Record<string, unknown>).tokenId))),
    });
    if (reconciliation.resolved.length > 0) {
      void this.stateStore?.save({ orders: reconciliation.resolved as never }).catch(() => undefined);
    }
    this.quorum.setReconciled(reconciliation.ok);
    this.snapshot.reconciled = reconciliation.ok;
    if (!reconciliation.ok) {
      console.warn(`[PolylandRuntime] RECONCILIATION BLOCKED: ${reconciliation.error} — no copy decisions until resolved`);
    }

    if (process.env.TWAP_ENABLED === 'true') { const twap = new ChainlinkTwapOracle({ autoReconnect: true, reconnectDelayMs: 3000, pingIntervalMs: 5000, maxStalenessMs: 30000 }); this.quorum.setTwapOracle(twap); void twap.connect(); }
    const buffer: SmartMoneyTrade[] = []; this.tradeSub = this.sdk.smartMoney.subscribeSmartMoneyTrades(t => {
      // Replacement detection layer: durable identity dedup + provenance gate.
      const detected = this.tradeDetector?.detect({
        wallet: t.traderAddress, conditionId: t.conditionId ?? '', marketSlug: t.marketSlug, tokenId: t.tokenId, outcome: t.outcome,
        side: t.side, size: t.size, price: t.price, timestamp: t.timestamp, sourceRef: t.txHash,
      });
      if (!detected || detected.status !== 'CONFIRMED') return;
      if (!this.quorum || this.quorum.getBasketCount() === 0) { if (buffer.length < 1000) buffer.push(t); } else this.quorum.onTrade(t);
    }, { filterAddresses: [], smartMoneyOnly: false });
    this.gamma = new GammaResolutionPoller(this.sdk.gammaApi, this.quorum, 300000); this.gamma.start();
    this.clob = new ClobMarketWsService();
        this.clob.onMid(({ assetId, price }) => {
          this.quorum?.observeMid(assetId, price);
          // Feed the market-quality tracker continuously (chop/signed-move need a
          // price stream, not just the on-fire book snapshot).
          this.marketQuality?.record(assetId, price);
        });
    // Subscribe only when quorum has a near-miss or an enabled anti-sniper
    // guard requests a token; an unfiltered CLOB subscription causes slow-
    // consumer disconnects and was the old mid-feed failure mode.
    this.quorum.onMidInterest = (tokenId) => this.clob?.subscribe([tokenId]);
    const candidates = await ingestion.collect(); const key = JSON.stringify({ version: 1, candidates: candidates.map(c => ({ address: c.address, source: c.source, autoRank: c.autoRank })).sort((a,b) => a.address.localeCompare(b.address)), config: this.screeningConfig });
    let screened: any[] | null = null; try { const cached = JSON.parse(await readFile('./data/wallet-screening.json', 'utf8')); if (cached.cacheKey === key && Date.now() - cached.savedAt < 21600000) screened = cached.screened; } catch {}
    const persisted = await this.stateStore.load(); if (!screened && Array.isArray(persisted?.walletUniverse)) screened = persisted.walletUniverse as any[];
    if (!screened) screened = await screening.score(candidates);
    // P0-7: do not seed baskets (and thus do not process buffered copy
    // candidates) until startup reconciliation has succeeded.
    if (this.snapshot.reconciled) {
      await this.seed(screened, key); for (const t of buffer) this.quorum.onTrade(t); buffer.length = 0;
    } else {
      console.warn(`[PolylandRuntime] HOLDING ${buffer.length} buffered trade(s) — reconciliation required before copy decisions resume`);
    }
    this.funnelTimer = setInterval(() => {
      this.quorum?.logFunnel();
      const metrics = this.config.botMetrics;
      if (metrics) {
        if (this.clob) metrics.mirrorClobIntegrity(this.clob.getIntegrityState());
        metrics.setFeedLagSeconds(this.quorum ? Math.max(0, (Date.now() - this.quorum.getLastFeedEventAt()) / 1000) : 0);
      }
    }, 300000); this.scheduleRefresh(21600000, ingestion, screening, key);
  }
  private async seed(screened: any[], key: string): Promise<void> { if (!this.quorum) return; const eligible = screened.filter(w => w.tier === 'PRIMARY' || w.tier === 'SATELLITE'); this.quorum.seed(eligible); setBonferroniGroups(this.quorum.getBasketCount()); await mkdir('./data', { recursive: true }); await writeFile('./data/wallet-screening.json', JSON.stringify({ savedAt: Date.now(), cacheKey: key, screened }), 'utf8').catch(() => undefined); await this.stateStore?.save({ walletUniverse: screened }); }
  private scheduleRefresh(delay: number, ingestion: WalletIngestionService, screening: WalletScreeningService, key: string): void { this.refreshTimer = setTimeout(async () => { if (!this.refreshing) { this.refreshing = true; try { const candidates = await ingestion.collect(); const screened = await screening.score(candidates); const nextKey = JSON.stringify({ version: 1, candidates: candidates.map(c => ({ address: c.address, source: c.source, autoRank: c.autoRank })).sort((a,b) => a.address.localeCompare(b.address)), config: this.screeningConfig }); await this.seed(screened, nextKey); } catch (e) { console.warn('[PolylandRuntime] screening refresh failed:', e instanceof Error ? e.message : e); } finally { this.refreshing = false; } } this.scheduleRefresh(21600000, ingestion, screening, key); }, delay); }
  /** Mutate the P&L/streak snapshot for one settled trade (no callback). */
  private applySettled(pnl: number): void { const s = this.snapshot; s.totalPnL += pnl; s.dailyPnL += pnl; s.monthlyPnL += pnl; if (pnl < 0) { s.consecutiveLosses++; s.consecutiveWins = 0; } else { s.consecutiveWins++; s.consecutiveLosses = 0; } s.currentCapital = this.config.capital.totalUsd + s.totalPnL; s.peakCapital = Math.max(s.peakCapital, s.currentCapital); s.currentDrawdown = (s.peakCapital - s.currentCapital) / s.peakCapital; }
  private recordSettled(pnl: number): void { this.applySettled(pnl); this.onSettledTrade?.(pnl); }
  /**
   * Reconcile the runtime P&L/streak snapshot with the replayed audit trail on
   * boot. Previously the audit store rebuilt its settled signals from the
   * append-only JSONL on restart, but the risk streak/PnL snapshot started at
   * zero and was only fed by live settlements going forward — so [edge] showed
   * the full settled history while [risk] showed an empty streak (audit: 8
   * settled but 0L/1W). Replaying settled realized P&L into the snapshot makes
   * the two systems agree after a restart.
   */
  private rebuildSnapshotFromAudit(): void {
      const s = this.snapshot;
      s.startTime = this.startedAt; s.dailyPnL = 0; s.totalPnL = 0; s.monthlyPnL = 0;
      s.consecutiveLosses = 0; s.consecutiveWins = 0;
      s.currentCapital = this.config.capital.totalUsd;
      s.peakCapital = this.config.capital.totalUsd; s.currentDrawdown = 0;
      s.permanentlyHalted = false; s.isPaused = false;
      let settledCount = 0;
      for (const sig of signalAuditStore.getSettledSignals()) {
        if (typeof sig.realizedEdge !== 'number') continue;
        this.applySettled(sig.realizedEdge);
        settledCount++;
      }
      if (settledCount > 0) console.log(`[PolylandRuntime] snapshot rebuilt from ${settledCount} settled audit signals (streak ${this.snapshot.consecutiveWins}W/${this.snapshot.consecutiveLosses}L)`);
    }
    getFunnelStats(): QuorumStats | null { return this.quorum?.getStats() ?? null; } getAuditStats() { return signalAuditStore.getStats(); } getStateSnapshot(): RuntimeStateSnapshot { return { ...this.snapshot, permanentlyHalted: this.risk ? !this.risk.canTrade() : false }; }
    /** P0-7: current reconciliation state (true = copy decisions allowed). */
    isReconciled(): boolean { return this.snapshot.reconciled; }
    /** Phase 5 gate: operator-facing go-live readiness from settled paper signals. */
    getGoLiveReport(): GoLiveReport {
      const settled = signalAuditStore.getSettledSignals().map((s) => ({
        id: s.id,
        conditionId: s.conditionId,
        domain: s.basket,
        firedAt: s.firedAt,
        settledAt: s.settledAt,
        realizedEdge: s.realizedEdge,
        deployedUsd: s.size * s.pricePaid,
        resolved: s.resolved,
      }));
      return computeGoLiveReport(settled, DEFAULT_GO_LIVE_CRITERIA);
    }
    /** One-line [gate] status: metrics + verdict, or NOT_READY when no settled signals. */
    goLiveStatusLine(): string {
      const report = this.getGoLiveReport();
      return `[gate] ${formatGoLiveReport(report)}`;
    }
    async stop(): Promise<void> { if (this.refreshTimer) clearTimeout(this.refreshTimer); if (this.funnelTimer) clearInterval(this.funnelTimer); this.tradeSub?.unsubscribe(); this.gamma?.stop(); this.clob?.stop(); this.quorum?.stopExitLadder();
    // Idempotency & cleanup audit: on shutdown in LIVE mode, cancel all open
    // CLOB orders so no resting/dangling orders are left exposed (mirrors
    // the systemd drain-then-exit pattern). DRY_RUN skips (no real orders).
    if (!this.config.dryRun) {
      try {
        const cancel = await Promise.race([
          this.sdk.tradingService.cancelAllOrders(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('cancelAll timeout')), 10_000)),
        ]);
        console.log(`[PolylandRuntime] shutdown: cancelled open orders (success=${cancel.success})`);
      } catch (err) {
        console.warn('[PolylandRuntime] shutdown: order cancellation failed:', err instanceof Error ? err.message : err);
      }
    }
    this.stateStore?.close?.(); await this.ledger?.close(); this.sdk.stop(); }
}
