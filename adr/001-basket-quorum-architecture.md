# ADR-001: Multi-Wallet Basket Quorum over Single-Wallet Mirroring

**Status:** Accepted
**Date:** 2026-09-01
**Deciders:** Celmaro

## Context

Polyland's original design (MrFadiAi/Polymarket-bot) mirrors a single target wallet. This is
simple but fragile: one lucky streak, one bot, or one drift event degrades the entire strategy.
The goal is a basket-quorum system where N distinct wallets are monitored and a trade fires only
when a configurable threshold (e.g. 3 of 5, or 5 of 8) agree on the same outcome within a
tight time-and-price window.

## Decision

Track wallets in domain-specific baskets (Crypto, Sports, Politics, Esports, etc.).
Record votes per conditionId per time-window. Fire execution only when quorum threshold is reached
AND price band check passes AND staleness/thin-edge filters clear.

## Consequences

- **Better signal quality**: false positives from a single bad actor are suppressed by consensus.
- **Latency budget tightens**: additional filter layers add 5-20ms. Acceptable for 30s+ market windows.
- **Wallet ingestion complexity**: need two sources (manual + auto from leaderboard) converging to same
  screening pipeline. Implemented in `wallet-ingestion-service.ts`.
- **Operational monitoring**: quorum stats must be observable. Implemented as `logFunnel()` + `getStats()`.

---

# ADR-002: Filter Ordering — Staleness + Thin-Edge BEFORE Quorum

**Status:** Accepted
**Date:** 2026-09-01
**Deciders:** Celmaro

## Context

Zeabur runlogs (2026-09-01) showed `quorum_rejected=25` vs `quorum_reached=8` — over 75% of quorum
attempts were wasted on markets that should have been filtered earlier. The Polymeteo reference
(copy_engine.py) runs staleness check at discovery time, not at quorum evaluation.

## Decision

Restructure `BasketQuorumService.onTrade()` into three sequential phases:

1. **Pre-vote filters** (`_isThinEdge`, `_isMarketStale`) — reject before any state is touched.
2. **Vote recording** — only for markets that pass phase 1.
3. **Quorum evaluation** — only for wallets that passed phase 1 AND have enough votes.

## Consequences

- Votes are no longer consumed by dead/stale markets → quorum fires only on live markets.
- Wallets in `WATCHLIST` tier can be pre-filtered before consuming vote budget.
- Debugging is cleaner: `quorumSkippedThinEdge` and `quorumSkippedStaleMarket` counters distinguish
  the filter stage from the quorum stage.

---

# ADR-003: Per-Basket Bankroll Isolation with Dynamic Sizing

**Status:** Accepted
**Date:** 2026-09-01
**Deciders:** Celmaro

## Context

A single shared capital pool for all baskets means one category (e.g. Esports) can consume the
entire bankroll on a hot streak, starving Crypto or Politics. PredictEngine and Polyland's
`strategyAllocation` both implement per-strategy isolation.

## Decision

Each `MarketCategory` has an independent `bankrollSlice` (fraction of total capital, must sum ≤ 1.0).
Within a basket, `RiskManager` applies dynamic sizing:
- Shrink by `lossSizingReduction` (default 0.20×) per consecutive loss.
- Grow by `winSizingIncrease` (default 0.10×) per consecutive win.
- Floor: 0.10× of base size. Ceiling: 2.0× of base size.

`RiskManager` also enforces 4-layer halt gates: daily loss, monthly loss, drawdown, total loss.

## Consequences

- Categories are firewalled: one basket blowing up cannot consume another basket's allocation.
- Dynamic sizing is adaptive to market conditions but bounded to prevent runaway leverage.
- `recordSettledTrade()` feeds realized P&L back to RiskManager for accurate drawdown tracking.

---

# ADR-004: Vote State Persistence via File-Backed JSON

**Status:** Accepted
**Date:** 2026-09-01
**Deciders:** Celmaro

## Context

A production deployment on Zeabur restarts without notice. In-memory vote state (votes Map,
lastFired Map) is lost on restart, causing the bot to miss in-progress quorum windows and
re-trigger on markets that already fired.

## Decision

`VoteStateStore` persists votes and lastFired timestamps to a JSON file in the data directory.
Writes are atomic (write to `.tmp` then rename). A 500ms debounce prevents write storms during
burst activity. State is loaded on `BasketQuorumService` construction.

## Consequences

- Survives restarts without double-firing on markets that already triggered.
- No SQLite dependency (avoids native module issues on Zeabur).
- JSON is human-readable for on-call debugging.
- Future: swap for SQLite if write latency becomes a bottleneck (not expected at <1 vote/sec).

---

# ADR-005: Wallet Screening — Three-Level Category Resolution

**Status:** Accepted
**Date:** 2026-09-01
**Deciders:** Celmaro

## Context

Manual wallets (operator-provided) may come with a category hint. Auto-discovered wallets
(from Polymarket leaderboards) come with a leaderboard-assigned category. Both paths need
to route to the correct basket. Incorrect routing pollutes basket signals.

## Decision

`WalletScreeningService.resolveCategory()` resolves in priority order:

1. **Manual hint** — if `lockCategory: true` on `ManualWalletSpec`, use `hintCategory` verbatim.
2. **Leaderboard category** — if wallet came from the leaderboard, use `leaderboardCategory`.
3. **Activity inference** — fetch last 50 trades via `getWalletActivity()`, map each trade's
   `marketSlug` through `categorizeMarket()`, pick the mode category.

Quality gate (consistency score) gates basket membership. Bot detection rejects wallets with
`smartScore ≥ 95 AND winRate ≥ 0.75 AND tradeCount ≥ 500`.

## Consequences

- Manual wallets respect operator intent but can still be overridden by activity if `lockCategory: false`.
- Auto wallets get routed without requiring extra API calls (category is free from leaderboard).
- Activity inference adds latency only for manual wallets without hints — bounded to 10 concurrent.
- Tier classification: PRIMARY / SATELLITE / WATCHLIST / REJECTED drives basket composition.
