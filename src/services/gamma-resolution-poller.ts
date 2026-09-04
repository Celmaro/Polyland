/**
 * GammaResolutionPoller
 *
 * Polls CLOB for market resolutions (Gamma's /markets?condition_id filter is broken —
 * it silently ignores the filter and returns random markets).
 *
 * Every `intervalMs`, collects all fired-but-unsettled conditionIds from
 * the SignalAuditStore and batch-checks them against CLOB. Any that have
 * a resolution (closed=true) are settled via
 * BasketQuorumService.handleMarketResolved(), which updates the audit trail,
 * basket winRate EMAs, and RiskManager P&L.
 *
 * Crypto up/down markets settle within 15 min of expiry; sports within 1–4 h.
 * A 5-minute poll interval is aggressive enough to catch crypto without
 * hammering the API.
 */

import { GammaApiClient } from '../clients/gamma-api.js';
import { BasketQuorumService } from './basket-quorum-service.js';

const LOG_INTERVAL = 10;  // log once every N poll cycles
const CLOB_BASE = 'https://clob.polymarket.com';

interface ClobMarketToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

interface ClobMarketResponse {
  condition_id: string;
  closed: boolean;
  active: boolean;
  accepting_orders: boolean;
  end_date_iso?: string;
  market_slug?: string;
  tokens?: ClobMarketToken[];
}

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
      console.error(`[ResolutionPoller] initial poll error: ${msg}`);
    });
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ResolutionPoller] poll error: ${msg}`);
      });
    }, this.intervalMs);
    console.log(`[ResolutionPoller] started — polling every ${this.intervalMs / 1000}s (CLOB)`);
  }

  /** Stop polling. */
  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[ResolutionPoller] stopped');
  }

  /**
   * Fetch a market from CLOB by conditionId.
   * CLOB /markets/{conditionId} is authoritative — returns the exact market
   * with tokens[] including winner flag.
   */
  private async fetchClobMarket(conditionId: string): Promise<ClobMarketResponse | null> {
    try {
      const url = `${CLOB_BASE}/markets/${conditionId}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`CLOB ${res.status}: ${await res.text()}`);
      }
      return await res.json() as ClobMarketResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.warn(`[ResolutionPoller] timeout fetching ${conditionId.slice(0, 10)}`);
        return null;
      }
      throw err;
    }
  }

  private async poll(): Promise<void> {
    this.pollCount++;

    // Collect unsettled fired conditionIds from the audit store
    const conditionIds = this.quorum.getUnsettledConditionIds();
    if (conditionIds.length === 0) {
      if (this.pollCount % LOG_INTERVAL === 1) {
        console.log('[ResolutionPoller] idle — no unsettled signals');
      }
      return;
    }

    // Always log when we have unsettled signals to check
    console.log(`[ResolutionPoller] checking ${conditionIds.length} unsettled signals...`);

    // Batch-fetch each market from CLOB (authoritative)
    const results = await Promise.allSettled(
      conditionIds.map((cid) => this.fetchClobMarket(cid))
    );

    let settled = 0;
    let notFound = 0;
    let notResolved = 0;
    let errors = 0;
    for (let i = 0; i < conditionIds.length; i++) {
      const result = results[i];
      if (result.status !== 'fulfilled') {
        errors++;
        console.warn(`[ResolutionPoller] fetch failed for ${conditionIds[i].slice(0, 10)}: ${result.reason}`);
        continue;
      }
      if (!result.value) {
        notFound++;
        continue;
      }
      const market = result.value;
      const marketSlug = market.market_slug ?? '';

      // Settlement detection — two sources, because their `closed` semantics lag
      // differently:
      //   1. CLOB /markets/{cid}.closed — flips when the market fully stops
      //      accepting orders. This can LAG Gamma by several minutes after
      //      expiry while the UMA resolution finalizes (verified in prod:
      //      xrp-updown-5m-1788501900 resolved on Gamma at prices [1,0] while
      //      CLOB still reported closed=False).
      //   2. Gamma /events?slug={slug}.markets[0] — `closed=true` with
      //      outcomePrices ["1","0"] or ["0","1"] is the earlier resolution
      //      signal. We only use it when CLOB says open but past expiry.
      const clobClosed = market.closed === true;

      if (!clobClosed) {
        // Fallback: ask Gamma for the event-market state.
        try {
          const gmk = await this.gamma.getMarketBySlug(marketSlug);
          if (!gmk) { notResolved++; continue; }
          const graw = gmk as unknown as Record<string, unknown>;
          const gClosed = graw.closed === true;
          const gPrices: number[] = (gmk.outcomePrices ?? []).map(Number);
          const gOutcomes: string[] = (gmk.outcomes ?? []);
          // Gamma prices [0.9995, 0.0005] or [1,0] both count as resolved
          const maxP = gPrices.length ? Math.max(...gPrices) : 0;
          const minP = gPrices.length ? Math.min(...gPrices) : 1;
          if (!gClosed || maxP < 0.99) { notResolved++; continue; }
          const winnerIdx = gPrices.indexOf(maxP);
          const winningOutcome = gOutcomes[winnerIdx];
          this.quorum.handleMarketResolved(conditionIds[i], winningOutcome, gPrices);
          settled++;
          continue;
        } catch (gErr) {
          console.warn(`[ResolutionPoller] gamma fallback failed for ${conditionIds[i].slice(0, 10)}: ${gErr instanceof Error ? gErr.message : gErr}`);
          notResolved++;
          continue;
        }
      }

      // Determine winning outcome from tokens (authoritative winner flag)
      const tokens = market.tokens ?? [];
      let winnerIdx = -1;
      let winningOutcome: string | undefined;
      for (let j = 0; j < tokens.length; j++) {
        if (tokens[j].winner === true) { winnerIdx = j; break; }
      }
      if (winnerIdx >= 0) {
        winningOutcome = tokens[winnerIdx].outcome;
      }

      // Build price array matching outcomes order for handleMarketResolved
      const prices: number[] = tokens.map((t) => Number(t.price));

      this.quorum.handleMarketResolved(conditionIds[i], winningOutcome, prices);
      settled++;
    }

    // Always log results when we had unsettled signals
    console.log(
      `[ResolutionPoller] checked ${conditionIds.length} unsettled: ` +
      `settled=${settled} notResolved=${notResolved} notFound=${notFound} errors=${errors}`
    );
  }
}
