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
import { GammaResolutionPoller } from './gamma-resolution-poller.js';
import type { SmartMoneyTrade } from './smart-money-service.js';
import { DecisionLedger } from './decision-ledger.js';
import { computeGoLiveReport, DEFAULT_GO_LIVE_CRITERIA, formatGoLiveReport, type GoLiveReport } from './go-live-gate.js';
export interface PolylandRuntimeConfig {
  dryRun: boolean;
  capital: { totalUsd: number };
  risk: Record<string, number | boolean>;
  smartMoney: { enabled: boolean; topN: number; customWallets: string[] };
  independence?: { maxHHI: number; minNEffective: number; clusterThreshold?: number; consensusStrengthPrimary?: number; consensusStrengthSatellite?: number; capPerWallet?: number };
  basketRisk?: import('./basket-risk.js').BasketRiskConfig;
  paperExploration?: boolean;
}
export interface RuntimeStateSnapshot { startTime: number; dailyPnL: number; totalPnL: number; monthlyPnL: number; consecutiveLosses: number; consecutiveWins: number; currentCapital: number; peakCapital: number; currentDrawdown: number; permanentlyHalted: boolean; isPaused: boolean; }
type ScreeningConfig = Record<string, unknown>;
export class PolylandRuntime {
  private quorum: BasketQuorumService | null = null;
  private ledger: DecisionLedger | null = null;
  private risk: RiskManager | null = null;
  private stateStore: any = null;
  private tradeSub: { unsubscribe: () => void } | null = null;
  private gamma: GammaResolutionPoller | null = null;
  private clob: ClobMarketWsService | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private funnelTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private readonly startedAt = Date.now();
  private readonly snapshot: RuntimeStateSnapshot;
  constructor(private readonly sdk: PolymarketSDK, private readonly config: PolylandRuntimeConfig, private readonly screeningConfig: ScreeningConfig, private readonly quorumConfig: BasketQuorumConfig, private readonly onSettledTrade?: (pnl: number) => void) {
    this.snapshot = { startTime: this.startedAt, dailyPnL: 0, totalPnL: 0, monthlyPnL: 0, consecutiveLosses: 0, consecutiveWins: 0, currentCapital: config.capital.totalUsd, peakCapital: config.capital.totalUsd, currentDrawdown: 0, permanentlyHalted: false, isPaused: false };
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
    SignalAuditStore.enableJsonl('./data/signal-audit.jsonl'); signalAuditStore.setStateStore(this.stateStore); signalAuditStore.replayJsonl('./data/signal-audit.jsonl');
    this.ledger = new DecisionLedger();
    const ledgerRecords = await this.ledger.start();
    console.log(`[PolylandRuntime] decision ledger replayed ${ledgerRecords.length} records`);
    this.quorum = new BasketQuorumService(this.sdk.tradingService, this.quorumConfig); this.quorum.setRiskManager(this.risk); if (this.config.independence) this.quorum.setIndependenceSettings(this.config.independence); if (this.config.basketRisk) this.quorum.setBasketRiskConfig(this.config.basketRisk); this.quorum.setPaperExplorationMode(this.config.paperExploration ?? false); this.quorum.setGammaApi(this.sdk.gammaApi); this.quorum.setDecisionLedger(this.ledger); this.quorum.setSpecializationThresholds(Number(this.screeningConfig.minCategoryTrades ?? 3), Number(this.screeningConfig.minCategoryWinRate ?? 0.58)); this.quorum.startExitLadder(); this.quorum.onSettledTrade = p => { this.recordSettled(p); this.onSettledTrade?.(p); };
    if (process.env.ANTI_SNIPER_ENABLED === 'true') this.quorum.setAntiSniper(new AntiSniperGuard(null));
    if (process.env.TWAP_ENABLED === 'true') { const twap = new ChainlinkTwapOracle({ autoReconnect: true, reconnectDelayMs: 3000, pingIntervalMs: 5000, maxStalenessMs: 30000 }); this.quorum.setTwapOracle(twap); void twap.connect(); }
    const buffer: SmartMoneyTrade[] = []; this.tradeSub = this.sdk.smartMoney.subscribeSmartMoneyTrades(t => { if (!this.quorum || this.quorum.getBasketCount() === 0) { if (buffer.length < 1000) buffer.push(t); } else this.quorum.onTrade(t); }, { filterAddresses: [], smartMoneyOnly: false });
    this.gamma = new GammaResolutionPoller(this.sdk.gammaApi, this.quorum, 300000); this.gamma.start();
    this.clob = new ClobMarketWsService();
    this.clob.onMid(({ assetId, price }) => this.quorum?.observeMid(assetId, price));
    // Subscribe only when quorum has a near-miss or an enabled anti-sniper
    // guard requests a token; an unfiltered CLOB subscription causes slow-
    // consumer disconnects and was the old mid-feed failure mode.
    this.quorum.onMidInterest = (tokenId) => this.clob?.subscribe([tokenId]);
    const candidates = await ingestion.collect(); const key = JSON.stringify({ version: 1, candidates: candidates.map(c => ({ address: c.address, source: c.source, autoRank: c.autoRank })).sort((a,b) => a.address.localeCompare(b.address)), config: this.screeningConfig });
    let screened: any[] | null = null; try { const cached = JSON.parse(await readFile('./data/wallet-screening.json', 'utf8')); if (cached.cacheKey === key && Date.now() - cached.savedAt < 21600000) screened = cached.screened; } catch {}
    const persisted = await this.stateStore.load(); if (!screened && Array.isArray(persisted?.walletUniverse)) screened = persisted.walletUniverse as any[];
    if (!screened) screened = await screening.score(candidates);
    await this.seed(screened, key); for (const t of buffer) this.quorum.onTrade(t); buffer.length = 0;
    this.funnelTimer = setInterval(() => this.quorum?.logFunnel(), 300000); this.scheduleRefresh(21600000, ingestion, screening, key);
  }
  private async seed(screened: any[], key: string): Promise<void> { if (!this.quorum) return; const eligible = screened.filter(w => w.tier === 'PRIMARY' || w.tier === 'SATELLITE'); this.quorum.seed(eligible); setBonferroniGroups(this.quorum.getBasketCount()); await mkdir('./data', { recursive: true }); await writeFile('./data/wallet-screening.json', JSON.stringify({ savedAt: Date.now(), cacheKey: key, screened }), 'utf8').catch(() => undefined); await this.stateStore?.save({ walletUniverse: screened }); }
  private scheduleRefresh(delay: number, ingestion: WalletIngestionService, screening: WalletScreeningService, key: string): void { this.refreshTimer = setTimeout(async () => { if (!this.refreshing) { this.refreshing = true; try { const candidates = await ingestion.collect(); const screened = await screening.score(candidates); const nextKey = JSON.stringify({ version: 1, candidates: candidates.map(c => ({ address: c.address, source: c.source, autoRank: c.autoRank })).sort((a,b) => a.address.localeCompare(b.address)), config: this.screeningConfig }); await this.seed(screened, nextKey); } catch (e) { console.warn('[PolylandRuntime] screening refresh failed:', e instanceof Error ? e.message : e); } finally { this.refreshing = false; } } this.scheduleRefresh(21600000, ingestion, screening, key); }, delay); }
  private recordSettled(pnl: number): void { const s = this.snapshot; s.totalPnL += pnl; s.dailyPnL += pnl; s.monthlyPnL += pnl; if (pnl < 0) { s.consecutiveLosses++; s.consecutiveWins = 0; } else { s.consecutiveWins++; s.consecutiveLosses = 0; } s.currentCapital = this.config.capital.totalUsd + s.totalPnL; s.peakCapital = Math.max(s.peakCapital, s.currentCapital); s.currentDrawdown = (s.peakCapital - s.currentCapital) / s.peakCapital; }
    getFunnelStats(): QuorumStats | null { return this.quorum?.getStats() ?? null; } getAuditStats() { return signalAuditStore.getStats(); } getStateSnapshot(): RuntimeStateSnapshot { return { ...this.snapshot, permanentlyHalted: this.risk ? !this.risk.canTrade() : false }; }
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
    async stop(): Promise<void> { if (this.refreshTimer) clearTimeout(this.refreshTimer); if (this.funnelTimer) clearInterval(this.funnelTimer); this.tradeSub?.unsubscribe(); this.gamma?.stop(); this.clob?.stop(); this.quorum?.stopExitLadder(); this.stateStore?.close?.(); await this.ledger?.close(); this.sdk.stop(); }
}
