/**
 * GammaResolutionPoller
 *
 * Polls Gamma API for market resolutions, replacing the dead RTDS
 * `clob_market / market_resolved` topic.
 *
 * Every `intervalMs`, collects all fired-but-unsettled conditionIds from
 * the SignalAuditStore and batch-checks them against Gamma.  Any that have
 * a resolution (closed/resolved markets) are settled via
 * BasketQuorumService.handleMarketResolved(), which updates the audit trail,
 * basket winRate EMAs, and RiskManager P&L.
 *
 * Crypto up/down markets settle within 15 min of expiry; sports within 1–4 h.
 * A 5-minute poll interval is aggressive enough to catch crypto without
 * hammering Gamma.
 */

import { GammaApiClient } from '../clients/gamma-api.js';
import { BasketQuorumService } from './basket-quorum-service.js';

const LOG_INTERVAL = 10;  // log once every N poll cycles

export class GammaResolutionPoller {
  private readonly gamma: GammaApiClient;
  private readonly quorum: BasketQuorumService;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollCount = 0;
  private destroyed = false;

  constructor(
    gamma: GammaApiClient,
    quorum: BasketQuorumService,
    intervalMs = 5 * 60 * 1000,  // 5 min default
  ) {
    this.gamma = gamma;
    this.quorum = quorum;
    this.intervalMs = intervalMs;
  }

  /** Start polling. Idempotent. */
  start(): void {
    if (this.timer || this.destroyed) return;
    // Fire immediately on start, then on interval
    this.poll().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[GammaPoller] initial poll error: ${msg}`);
    });
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[GammaPoller] poll error: ${msg}`);
      });
    }, this.intervalMs);
    console.log(`[GammaPoller] started — polling every ${this.intervalMs / 1000}s`);
  }

  /** Stop polling. */
  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[GammaPoller] stopped');
  }

  private async poll(): Promise<void> {
    this.pollCount++;

    // Collect unsettled fired conditionIds from the audit store
    const conditionIds = this.quorum.getUnsettledConditionIds();
    if (conditionIds.length === 0) {
      if (this.pollCount % LOG_INTERVAL === 1) {
        console.log('[GammaPoller] idle — no unsettled signals');
      }
      return;
    }

    // Always log when we have unsettled signals to check
    console.log(`[GammaPoller] checking ${conditionIds.length} unsettled signals...`);

    // Batch-fetch each market from Gamma
    const results = await Promise.allSettled(
      conditionIds.map((cid) => this.gamma.getMarketByConditionId(cid))
    );

    let settled = 0;
    let notFound = 0;
    let notResolved = 0;
    let errors = 0;
    for (let i = 0; i < conditionIds.length; i++) {
      const result = results[i];
      if (result.status !== 'fulfilled') {
        errors++;
        console.warn(`[GammaPoller] fetch failed for ${conditionIds[i].slice(0, 10)}: ${result.reason}`);
        continue;
      }
      if (!result.value) {
        notFound++;
        continue;
      }
      const market = result.value;

      // Check if market is resolved: Gamma uses `closed` field
      const raw = market as unknown as Record<string, unknown>;
      const isClosed = raw.closed === true;

      if (!isClosed) {
        notResolved++;
        continue;
      }

      // Determine winning outcome from final prices
      const prices: number[] = (market.outcomePrices ?? []).map(Number);
      const outcomes: string[] = market.outcomes ?? [];
      let winnerIdx = -1;
      for (let j = 0; j < prices.length; j++) {
        if (prices[j] >= 0.99) { winnerIdx = j; break; }
      }
      const winningOutcome = winnerIdx >= 0 ? outcomes[winnerIdx] : undefined;

      this.quorum.handleMarketResolved(conditionIds[i], winningOutcome, prices);
      settled++;
    }

    // Always log results when we had unsettled signals
    console.log(
      `[GammaPoller] checked ${conditionIds.length} unsettled: ` +
      `settled=${settled} notResolved=${notResolved} notFound=${notFound} errors=${errors}`
    );
  }
}
