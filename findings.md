# Polyland Wallet, Quorum, and Basket Design

## Executive conclusion

There is no evidence-based formula that can guarantee profitability or a top-ten ranking. The correct target is a point-in-time, calibrated, cost-aware system whose forward performance can falsify itself. Raw win rate, leaderboard rank, ROI, and wallet count are insufficient.

The design below preserves Polyland's Basket Quorum strategy while replacing weak proxies with auditable estimates.

## Evidence base

Polymarket's official APIs separate Gamma market metadata, Data API wallet activity, CLOB books/orders, and realtime streams.[3][6][7] User trades expose wallet, side, asset, condition, size, price, timestamp, outcome, and transaction hash.[2] Books expose timestamp, bids, asks, minimum order size, tick size, risk mode, and last trade.[6] Polymarket orders are limit orders; immediately executable market orders can encounter delay, partial fills, and price movement.[4][5]

The external copy-trading material consistently emphasizes risk-adjusted scoring, liquidity/slippage checks, idempotent state, exposure limits, and execution speed, but the repositories do not establish independent profitability.[15][16][17] The public composite closest to Polyland uses Sharpe-normalized performance, edge-adjusted win rate, log ROI, drawdown resilience, and rank stability.[16]

Research on prediction markets supports calibration by domain and horizon, but warns that apparent effects can be estimation noise or platform-specific.[8][9] Shrinkage is appropriate when wallet samples are sparse.[10] Covariance shrinkage is appropriate when event histories are thin.[11] Backtest overfitting and selection among many wallets/rules require a locked forward test and data-snooping controls.[12][13][14]

## 1. Wallet data model

Store an event-sourced ledger, not only current wallet snapshots:

```text
wallet
trade_id = transactionHash + asset + conditionId + timestamp
wallet, conditionId, tokenId, outcome, side
size, price, notional, timestamp, discoveryTimestamp
marketDomain, horizon, marketStatusAtTrade
bookSnapshotId, bestAsk/bid, spread, depth
resolution, settlementPnl, fees, followerExecutablePnl
```

Separate:

```text
leader_price/PnL
follower_executable_price/PnL
```

A leader's fill is not the follower's fill. Replay must consume the contemporaneous order book, include spread, depth, tick/minimum-size rules, delay, partial fills, rejection, and fees.[4][5][6]

## 2. CopyScore: proposed formula

Do not use one undifferentiated score for eligibility and sizing. Compute these independently:

```text
SkillScore       = point-in-time skill estimate
ReliabilityScore = evidence quality/confidence
ExecutionScore   = copyability after lag and costs
Specialization   = domain-specific evidence
RiskScore        = drawdown/concentration/tail risk
```

### 2.1 Core skill estimate

For wallet w, domain d, horizon h, use resolved events only. Let:

```text
x_i = follower_net_pnl_i / follower_capital_at_risk_i
n_eff = effective resolved-event sample size
```

Use a winsorized/Hampel-filtered return only for stability diagnostics, never to erase real losses from risk accounting.[16]

Estimate excess return relative to the executable market baseline:

```text
edge_i = follower_net_pnl_i - market_baseline_net_pnl_i
```

Estimate a domain/horizon mean edge with a zero prior:

```text
lambda = n_eff / (n_eff + 30)
mu_edge = lambda * mean(edge_i)
```

The 30-event prior is a starting hypothesis, not a universal truth. It must be selected before holdout evaluation.

Use a lower confidence bound rather than the raw mean:

```text
LCB_edge = mu_edge - z * SE_clustered(edge_i)
```

where clustering is by market/event family, not merely by fill. For early screening, z=1.64 is a one-sided 95% LCB. If the number of independent resolved events is small, LCB remains near zero or negative.

### 2.2 Calibration and probability quality

When a wallet's action implies a forecast, or when its side is evaluated against market price p:

```text
Brier = mean((forecast - outcome)^2)
LogLoss = -mean(y*log(p) + (1-y)*log(1-p))
```

Estimate calibration by domain/horizon:

```text
logit(p_calibrated) = alpha[d,h] + beta[d,h] * logit(p_market)
```

Shrink alpha toward 0 and beta toward 1. Report reliability bins, calibration slope/intercept, Brier, log loss, and sample counts.[8][9]

A wallet that wins mostly at 95-cent prices is not equivalent to a wallet that buys 40-cent outcomes and realizes positive edge.

### 2.3 Risk-adjusted components

Normalize robustly against the point-in-time cohort, not a future global maximum:

```text
R = 0.30 * scale(LCB_edge)
  + 0.20 * scale(-Brier_or_calibration_loss)
  + 0.15 * scale(log_return)
  + 0.15 * scale(-max_drawdown)
  + 0.10 * scale(-CVaR_95)
  + 0.10 * scale(stability_across_subperiods)
```

`scale` must be fit on the training cohort and clipped to fixed bounds. Do not let raw PnL dominate. CVaR captures tail losses better than variance alone.[14]

### 2.4 SmartScore role

SmartScore must not be inserted twice. Prefer:

```text
CopyScore = 100 * Reliability * SkillComposite * ExecutionScore
```

where SmartScore is either:

```text
an input to SkillComposite exactly once
```

or removed and replaced by independently reconstructed metrics. It must not be both a Sharpe proxy and a slippage/consistency proxy.

### 2.5 Reliability score

```text
Reliability =
  sample_confidence
  * recency_confidence
  * data_completeness
  * identity_integrity
```

Recommended starting terms:

```text
sample_confidence = n_independent_events / (n_independent_events + 30)
recency_confidence = exp(-age_days / 30)
```

Do not give a wallet a high score because it has one recent win. A one-trade wallet should be WATCHLIST, never PRIMARY.

### 2.6 ExecutionScore

Measure copyability directly from historical replay:

```text
ExecutionScore =
  fill_rate
  * (1 - slippage_bps / slippage_cap_bps)
  * latency_survival_rate
  * market_depth_survival_rate
```

A wallet can be skilled but not copyable. Large trades, thin books, rapid price moves, or late discovery should lower ExecutionScore.

### 2.7 Specialization

For domain d:

```text
DomainEdge_LCB(d) > 0
n_independent_events(d) >= 12
calibration_loss(d) <= baseline + tolerance
```

Do not route a crypto specialist into politics merely because its aggregate score is high. If domain evidence is weak, use `other/watchlist`, not a confident basket.

### 2.8 Practical tiers

```text
PRIMARY:
  n_independent_events >= 30
  LCB_edge > 0 after costs
  Reliability >= 0.60
  no risk flags
  domain evidence valid
  ExecutionScore >= 0.50

SATELLITE:
  n_independent_events >= 12
  LCB_edge >= 0 or neutral within tolerance
  Reliability >= 0.35
  strict per-wallet cap

WATCHLIST:
  insufficient evidence, recent regime change, or copyability unknown
```

These are starting gates for paper evaluation, not proven optimal thresholds.

## 3. Quorum logic

The current tiered quorum is a good safety skeleton, but raw distinct-wallet count is not enough.

### 3.1 Normalize actions

Every action must carry:

```text
wallet, tier, domain, conditionId, tokenId, outcome, side
price, size, timestamp, discoveryLatency
```

Normalize SELL into the corresponding directional thesis only when the binary mapping is valid. Never infer the opposite of a non-binary label.

### 3.2 Effective independent breadth

For candidate signal j, assign wallet weights:

```text
w_i = Reliability_i * SkillEvidence_i * ExecutionScore_i
```

Cap each wallet at 0.35 of total weight. Calculate:

```text
HHI = sum((w_i / sum(w))^2)
N_eff = 1 / HHI
```

Also calculate shared-market overlap and timing correlation. If wallets repeatedly copy the same leader or react at the same timestamp, treat them as one cluster for quorum purposes.

### 3.3 Proposed quorum decision

A signal reaches `QUORUM_REACHED` only if:

```text
at least 2 independent PRIMARY wallets
OR 1 PRIMARY + 2 independent SATELLITES
OR 4 independent SATELLITES with stronger execution evidence
```

and:

```text
N_eff >= 2.0
HHI <= 0.45
weighted consensus >= threshold
signal age <= max_age
no wallet contributes more than its cap
```

Weighted consensus:

```text
consensus_strength = sum(w_i for side) / sum(w_i for all eligible recent actions)
```

Starting thresholds:

```text
PRIMARY routes: strength >= 0.60
SATELLITE-only route: strength >= 0.70 and N_eff >= 3
```

The old `2P`, `1P+2S`, `5S` rule should remain as a hard minimum, but it must be combined with independence and execution evidence.

### 3.4 Avoid starvation

Do not lower quality thresholds globally to solve starvation. Use explicit modes:

```text
normal mode:
  strict LCB, independence, execution and edge gates

exploration paper mode:
  allow near-misses into a shadow ledger only
  never live execute

fallback mode:
  only if no signal for a pre-registered interval
  reduce size, require at least 2 independent PRIMARY/SATELLITE contributors
  label results separately
```

Every rejected candidate must be logged with one reason. The current logs show stale events dominate: approximately 1,822 stale out of 2,030 filtered events in the latest window, with zero fires. That is a feed freshness/data-path issue before it is a quorum-threshold issue.

## 4. Basket logic

Baskets should represent independent decision domains, not merely category labels.

### 4.1 Basket membership

Assign a wallet to domain d only if:

```text
DomainEdge_LCB(d) > 0
n_eff(d) >= 12
specialization confidence >= threshold
```

A wallet can belong to multiple baskets, but its capital and contribution must be counted once at portfolio level.

### 4.2 Portfolio constraints

For each basket:

```text
max basket allocation = pre-registered capital slice
max market exposure = min(global market cap, basket cap)
max event-family exposure = correlated-event cap
max wallet exposure = wallet cap
```

Use covariance shrinkage toward domain/event-family structure when data is sparse.[11]

A practical starting allocation for $250 paper capital:

```text
crypto short-horizon: 20%
politics: 20%
sports: 15%
economics/finance: 15%
entertainment/science/other: 10%
reserve/unallocated: 20%
```

These are risk budgets, not target investment. The reserve prevents one active category from consuming all capital.

### 4.3 Basket-level promotion/demotion

Evaluate baskets on a rolling, point-in-time basis:

```text
promote if:
  >= 30 independent resolved signals
  LCB basket edge > 0 after costs
  no severe drawdown/concentration breach

demote if:
  LCB edge < 0
  calibration deteriorates materially
  stale/failed-fill rate rises
  event concentration exceeds cap
```

Do not recalculate tiers from the same outcomes used to claim performance without a holdout.

## 5. What third parties get right and wrong

### Transferable

- Poly Syncer's public composite is directionally sound: risk-adjusted performance, edge-adjusted win rate, log ROI, drawdown, and stability rather than raw PnL.[16]
- Public copy bots emphasize liquidity/slippage checks, per-market/category caps, idempotent state, retries, audit logs and crash recovery.[15][16]
- Poly-scout-style tools surface diversification, ROI proxies, recent volume spikes, and multi-wallet consensus.[17]
- Homerun-style designs add rolling windows, Sharpe/Sortino/drawdown/profit factor, confluence, overlap clustering and behavioral labels.[18]

### Do not copy blindly

- “Sub-three-second” and “top-ten” marketing claims are not proof of net profitability.
- A 60% win-rate threshold is not statistically sufficient without price/payoff context, sample size and costs.[15]
- Kelly sizing is fragile when p and payoff are estimated from selected, correlated, non-stationary events.
- Raw wallet count is not independent consensus.
- Follower fills cannot be simulated at leader price.
- A leaderboard is a selection mechanism; its best current wallets are not an unbiased sample.

## 6. Polyland-specific diagnosis

Latest Zeabur telemetry:

```text
received=45844
ignored=46643
recorded=1481
filtered=2030 (thin=208, stale=1822)
fired=0
risk=0
bankroll=0
drift=26
antiSniper=0
twap=0/0
liq=0
negEdge=7
minSize=15
```

Interpretation:

1. The bot is not currently starved primarily by tier quorum. The largest visible loss is stale input: 1,822 of 2,030 filtered events.
2. `ignored > received` is an accounting bug or counter-semantics problem; it must be fixed before using funnel percentages.
3. TWAP and anti-sniper are not active blockers in this window.
4. Drift is protecting against chasing already-moved prices.
5. The next engineering priority is point-in-time data freshness and attribution, not making quorum looser.
6. The earlier one-fire sample cannot establish profitability; no settled outcomes are available.

## 7. Implementation order

Do not implement the entire design in one rewrite.

### Slice A: measurement contract

Add an append-only candidate ledger before every gate:

```text
candidateId, wallet, eventId, discoveredAt, tradeAt
ageMs, domain, tier, score components
quorum group, HHI, N_eff, consensus strength
book snapshot, executable VWAP, expected edge
final decision, rejection reason
```

Fix counters so:

```text
received_raw
ignored_invalid
ignored_unseeded
ignored_not_member
filtered_stale
filtered_thin
votes_recorded
quorum_attempted
quorum_reached
execution_blocked
executed
settled
```

are monotonic and mutually interpretable.

### Slice B: point-in-time wallet metrics

Implement event-based settled-position reconstruction and cost-aware replay before changing thresholds. Preserve raw PnL, follower-executable PnL, calibration, and confidence separately.

### Slice C: confidence-aware CopyScore

Replace current score inputs with:

```text
CopyScore = 100 * Reliability * (
  0.30*LCB_edge_score
 +0.20*calibration_score
 +0.15*log_return_score
 +0.15*drawdown_score
 +0.10*CVaR_score
 +0.10*stability_score
) * ExecutionScore
```

Retain SmartScore only once or remove it after reconstructing the underlying metric. Add domain/horizon fields and score explanations.

### Slice D: independence-aware quorum

Add HHI, N_eff, shared-market overlap, timing correlation, weighted consensus strength, and cluster-aware wallet caps. Keep old tier minimums as hard safety floors.

### Slice E: basket risk budgets

Add market/event-family caps, covariance shrinkage, reserve capital, and basket promotion/demotion from forward results.

### Slice F: evaluation

Run paper shadow A/B:

```text
current CopyScore/quorum/baskets
vs
confidence-aware score + independence-aware quorum + risk-budget baskets
```

Use the same candidates and books, freeze rules for the window, settle outcomes, and compare against equal-weight quorum, market-price baseline, and no-copy.

## 8. Go-live decision

Do not go live yet.

Go live only after:

```text
at least one complete forward window with resolved signals
positive net follower-executable edge after fees/slippage
confidence interval or LCB above zero
no severe concentration or drawdown breach
stable fill/reconciliation/settlement behavior
no schema/age/counter ambiguity
operator-confirmed rollback switch
```

The bot may be pioneering in instrumentation and method, but no research source can make it “top ten” or guarantee profitability. The appropriate claim before evidence is: “Polyland has a falsifiable, cost-aware, independence-aware paper strategy.”
