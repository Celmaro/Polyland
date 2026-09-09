# Polyland — Consolidated Recommendation Report
### From auditing Celmaro/PredictCel (Python prototype) and Celmaro/Polycel (TS evolution) against Polyland

_Status: findings only — nothing implemented. All recommendations are additive and preserve PRIMARY/SATELLITE tiers, tiered quorum, routing, risk persistence, audit/replay, the go-live gate, and DRY RUN mode._

---

## 0. Executive summary

Polyland is the **newest, hardened, deployable** line: it is the only one of the three with tiered quorum + independence, a go-live gate, durable order/position recovery, a shared live/replay fill engine, audit/replay, and reconciliation-before-copy. PredictCel is an older **Python prototype**; Polycel is a newer **TypeScript evolution** but has a **flat** quorum model and no safety/evidence layer.

**The other two are not alternatives — they are idea mines.** Return to them as *sources of mechanisms* and keep Polyland as the single dev line. Their best ideas are bounded, additive ports that address Polyland's known pain points (buying tops, sizing starvation, negative edge, concentration, single-source wallet flooding).

---

## 1. How the three relate

| Repo | Type | Strength for Polyland |
|---|---|---|
| **Polyland** | TS, Zeabur, DRY RUN | The hardened deployed core (basket/quorum/execution/evidence) |
| **PredictCel** | Python prototype | Basket lifecycle, consensus coherence gates, Bayesian confidence, rebalancing, wallet ingestion pipeline |
| **Polycel** | TS, clob-client-v2 | Entry-quality scoring, quality-gated dynamic quorum, risk/exit machinery, multi-source wallet screening |

---

## 2. Recommendations by area

### A. Basket mechanisms

| # | Recommendation | Source | Value |
|---|---|---|---|
| A1 | **Wallet lifecycle** — `add / remove / suspend / observe` actions with explicit reasons; graduated, reversible (not hard blacklist) | PredictCel `basket_manager.py` | High |
| A2 | **Churn + capacity bounds** — `max_wallets_per_basket`, `max_new_wallets_per_run`, promotion buffer (must clear score threshold + buffer before entering) | PredictCel | High |
| A3 | **Persisted memberships with tiers + expiry** — `core / rotating / backup` with `rank`, `active`, `effective_until`; stale contributors age out | PredictCel `BasketMembership` | Med |
| A4 | **Basket health + target-allocation rebalancing** — `stale_ratio`, `clustered_ratio`, `fresh_core_wallets_24h`; auto-rebalance exposure to per-basket target when drift > 5% (attacks the 52–62% concentration) | PredictCel `BasketHealth`/`rebalance()` | High |
| A5 | **Basket overlap health snapshot** — % of active tokens with ≥2/3/4 overlapping wallets (complements HHI/N_eff) | Polycel `getBasketOverlapHealthSnapshot` | Low |

### B. Quorum & copy mechanisms

| # | Recommendation | Source | Value |
|---|---|---|---|
| B1 | **Consensus coherence gates** — reject quorum when aligned wallets' *own* entry prices are too spread (`price_band_abs`) or timestamps too scattered (`time_spread_seconds`); plus adaptive min-count toward actual tracked pool | PredictCel `evaluate_basket_consensus_gate` | **High** (anti-correlated-entry) |
| B2 | **Weighted-size agreement as a hard gate** — `weighted_consensus = aligned_size/total_size` with a floor (headcount alone insufficient) | PredictCel `copy_engine` | High |
| B3 | **Dominant-wallet concentration cap** — penalize when `max(aligned)/total_aligned > 0.75`; one whale can't manufacture quorum | PredictCel `_dominant_wallet_share` | High |
| B4 | **Bayesian confidence prior on the vote** — `(aligned + prior·0.5)/(total + prior)`, scaled by sample strength | PredictCel `_confidence_score` | Med |
| B5 | **Conflict penalty** — discount a market when real wallet weight sits on the opposite side (scalar complement to reverse-quorum) | PredictCel | Med |
| B6 | **Market-regime classification** (RANGE/TRANSITION/TREND/UNSTABLE) feeding scoring + sizing | PredictCel | Med |
| B7 | **Quality-gated dynamic quorum/window** — lower quorum→MIN / widen window ONLY when `basketQuorumSkips ≥ threshold` AND `entryQualitySkips === 0 && walletGateSkips === 0` (never loosens into a bad regime) | Polycel `getEffectiveBasketQuorum` | **High** (safe starvation relief) |
| B8 | **Per-wallet cooldown on consecutive stop-losses** — a source wallet hitting N SLs cools down for `WALLET_COOLDOWN_MINUTES` | Polycel `evaluateWalletGate` | Med |

### C. Wallet ingestion

| # | Recommendation | Source | Value |
|---|---|---|---|
| C1 | **Multi-source ingestion + source corroboration** — combine leaderboard + active-market-trade-participant + curated-file sources; tag each wallet with its source(s); bonus wallets confirmed by ≥2 independent sources | PredictCel `wallet_sources.py`, Polycel `sourcePresence` | **High** |
| C2 | **Wallet registry with lifecycle state** — `WalletRegistryEntry{source_type, source_ref, trust_seed, status: active|probation, first_seen/last_seen/last_scored, notes}`; new wallets enter as **probation**, promoted on evidence | PredictCel `wallet_registry.py` | High |
| C3 | **Two-stage entry into the quorum** — discovered wallets land in `WATCHLIST`/probation, promoted to `SATELLITE`/`PRIMARY` only after clearing sample/tier floors | PredictCel + reuse Polyland WATCHLIST tier | High |
| C4 | **Behavioral ingestion filters** — `burst_peak_60s`, `frequency_cap_weekly_trades`, `loss/win kill-switch`, `non_positive_expectancy`, in front of CopyScore (catches bots/wash traders) | Polycel `generate-canonical-wallets.ts` | High |
| C5 | **Topic-specialization profile → basket-aware assignment** — per-wallet `topic_affinities` + `specialization_score = Σ affinity²` (HHI of topic concentration) to route wallets into baskets from actual trade history | PredictCel `wallet_topics.py`/`BasketAssignmentEngine` | Med |
| C6 | **Discovery failure guards** — hard-fail a refresh when trade-fetch failure ratio ≥ 0.5; validate EVM addresses at boundary; keep last-good universe on degraded run | PredictCel | Med |
| C7 | **Single canonical wallet config + conflict detection** — error on >1 config source, explicit override path | Polycel `wallet-config.ts` | Low |

### D. Entry quality & execution/exit

| # | Recommendation | Source | Value |
|---|---|---|---|
| D1 | **Composite Entry-Quality score** — weighted 0–100 = `edge + spread + topDepth + freshness`; hard gate (score < MIN → skip); signal-edge gate with tolerance band; **graded sizing** (edge ≥ FULL → 1.0×, else 0.5×). Direct fix for "buying at 0.90–0.95" | Polycel `computeEntryQualityScore` | **Highest leverage** |
| D2 | **Risk-normalized R-multiple sizing** — `cap = TARGET_RISK_PER_TRADE_USDC / riskPct`, `riskPct = (entry−stopLoss)/entry` | Polycel `applyRiskAdjustedAmount` | High |
| D3 | **Post-entry microstructure invalidation** — exit immediately if spread blows past cap or top-of-book evaporates for N confirmation ticks | Polycel `risk-manager.ts` | Med |
| D4 | **Trailing take-profit (3-stage giveback) + trailing stop-loss (staged arm/trigger)** | Polycel `risk-manager.ts` | Med |
| D5 | **Effective stop-loss with absolute floor + high-price scaling** — steeper stop% for high-price entries, `max(relative, floor)` | Polycel `getEffectiveStopLossPrice` | Med |

### E. Observability / safety — already in Polyland (do NOT re-port)
Durable dedup, buy-once-per-market, edge floor + negative-edge rejection, drift gate, stale-quote cancel, bankroll reservation, restart recovery/reconciliation, per-category caps, bounded metrics labels, sequence-gap invalidation, audit/replay. Polycel/PredictCel have cruder versions; Polyland's are the hardened ones.

### F. Explicitly NOT to adopt
- **Flat `BASKET_COUNT_QUORUM` vote-count + fixed `walletOrderSize`** (Polycel) — a regression vs Polyland's tiered quorum + independence + reverse-quorum + copy-score sizing.
- **ML position sizing** (PredictCel RandomForest) — you rejected opaque/ML sizing.
- **Arbitrage sidecar / Redis / VaR stack** (PredictCel) — orthogonal infra.

---

## 3. Prioritized implementation roadmap (all dry-run, gate unchanged)

**Tier 1 — highest leverage, do first**
1. **D1** Entry-quality composite gate + graded sizing (attacks the entry-quality audit directly).
2. **B1** Consensus coherence gates (price-band / time-spread among votes).
3. **C1** Multi-source ingestion + source corroboration.
4. **C2/C3** Wallet registry lifecycle + probation→promotion.

**Tier 2 — strong, after Tier 1**
5. **B2/B3** Weighted-agreement hard gate + dominant-wallet cap.
6. **A4** Target-allocation rebalancing (concentration).
7. **D2** R-normalized risk sizing.

**Tier 3 — opportunistic**
8. **B7** Quality-gated dynamic quorum (starvation relief).
9. **B8 / C4** Per-wallet cooldown / behavioral ingestion filters.
10. **A1/A2/A3** Basket wallet lifecycle + capacity + promotion buffer.
11. **D3/D4/D5, B4/B5/B6, A5, C5/C6/C7** remaining.

**Repo strategy:** Polyland is the single dev line. Mine the shortlist from PredictCel/Polycel in order, tests-first. Dormant the other two (note "superseded by Polyland" in README, archive, stop maintaining).

---

*Prepared for Celmaro. Audit of PredictCel + Polycel against Polyland; findings-only until implementation is explicitly approved.*
