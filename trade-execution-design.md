# Trade Detection, Copy, and Exit Replacement Design

## Decision

Replace the current Activity-only trade intake, BUY-only execution assumption, and heuristic exit ladder with three explicit, independently testable boundaries:

```text
candidate observation
  -> authoritative trade reconciliation
  -> intent classification and quorum
  -> executable copy plan
  -> order/fill reconciliation
  -> position state machine
  -> value/risk/leader/resolution exit decision
```

This preserves Basket Quorum Smart-Money Copy Trading, wallet tiers, basket routing, risk halts, durable audit, settlement accounting, and DRY RUN. It replaces weak implementation paths rather than protecting them for compatibility.

## Research conclusions

1. Polymarket's market WebSocket is excellent for books, price changes, last trade price, tick changes, and market resolution, but `last_trade_price` is not wallet-attributed. It cannot be the wallet identity source.[1]
2. Polymarket's Data API provides wallet-attributed trades/activity and current/closed positions for reconciliation. Public trade records include wallet, side, asset, condition, size, price, timestamp, and transaction hash.[2][3]
3. Orders are signed limit orders. FOK and FAK are execution policies, not true market orders; immediate execution still consumes the current book and can face taker delay, partial fills, or no fill.[4]
4. A matched trade is not equivalent to a confirmed on-chain trade. The order lifecycle has distinct matched, mined, confirmed, retrying, and failed states. Copy accounting must use the follower's actual fill state.[4]
5. Public copy bots generally poll `/activity`, use timestamp watermarks, issue FOK/GTC copies, and either omit exits or mirror them. A public implementation specifically added transaction-hash idempotency, rejected sub-minimum trades, and fixed dead position handlers after production bugs.[5][6]
6. Market microstructure research shows feed-based trade-direction inference can be materially wrong; the cited Polymarket study reported about 61.5% agreement with on-chain direction in its sample. Direction and identity should therefore come from attributable fill data, not inferred book changes.[7]
7. Execution research supports modeling delay, spread, depth, price impact, partial fills, and fees. Copying after a leader fill is a different strategy from receiving the leader's price.[7][8]
8. Exit liquidity is a first-class risk in prediction markets. Holding to resolution avoids needing a buyer but locks capital; early exit requires an executable bid and can fail near resolution. A leader SELL must never be blindly mirrored if the follower has no matching position.[9][10]
9. Exchange copy-trading platforms use multi-window performance, drawdown, leader/follower outcomes, proportional sizing, aggregate caps, and independent follower risk controls. Their marketing claims are not evidence of Polymarket profitability.[11][12]
10. Recent community evidence consistently warns about alert latency, coordinated wallets, late copying, and becoming exit liquidity. These are hypothesis/risk inputs, not proof of a profitable rule.[13][14]

## Replacement A: authoritative trade detection

### Sources and roles

| Source | Role | Trust |
|---|---|---|
| Activity/Data API wallet trade | candidate observation and backfill | attributable, may lag |
| Polygon `OrderFilled` logs/indexer | authoritative identity/fill confirmation where available | attributable, confirmation latency |
| CLOB market WebSocket | book, spread, depth, tick, price movement, resolution | fast market state, anonymous trades |
| CLOB user channel | follower order/fill lifecycle | authoritative for our orders |

The detector uses a **fast path plus reconciliation path**:

1. Activity/WebSocket callback creates a `DETECTED` candidate immediately.
2. Candidate key is `transactionHash + asset + conditionId`; if transaction hash is absent, use a canonical hash of wallet, asset/condition, side, size, price, and timestamp bucket and mark identity as provisional.
3. The detector claims the key durably before downstream processing.
4. Data API/on-chain reconciliation confirms the wallet, asset, side, size, price, and timestamp. A mismatch becomes `REJECTED_IDENTITY`, never a copy.
5. A bounded overlap backfill runs after reconnect and periodically. Watermarks use event time with overlap, not only `lastSeenTimestamp`, so equal timestamps and out-of-order delivery cannot lose trades.
6. A bounded queue separates detection from position polling and order reconciliation. Slow reconciliation cannot starve detection.
7. Fills by the same wallet/market/side within a configurable aggregation window are grouped into one leader intent for quorum, while raw fills remain immutable for audit.

### Detection acceptance

A candidate is actionable only if:

```text
identity confirmed OR explicit paper-only provisional policy
and timestamp is valid and not stale
and market is active and unresolved
and size/notional passes a real minimum
and wallet is an eligible basket member
and event is not duplicate/replayed
```

The detector records every rejected reason: `duplicate`, `stale`, `identity_mismatch`, `invalid_market`, `unresolved`, `dust`, `unsupported`, `reconciliation_timeout`.

## Replacement B: executable copy planner

The copy planner does not copy a leader's printed price. It copies a **validated intent**:

```text
leader direction + market + size conviction + quorum evidence
```

### Plan calculation

For a BUY of token `t`:

```text
p_entry = executable ask VWAP for requested shares
cost = shares * p_entry + taker_fee + expected_failure_cost
p_fair = calibrated basket probability for the directional thesis
edge = p_fair - p_entry - fee_per_share - slippage_buffer

kelly = clamp(edge / max(p_entry * (1 - p_entry), epsilon), 0, 1)
allocation = capital
           * fractionalKelly
           * reliability
           * executionConfidence
           * independenceAdjustment
           * basketRiskHeadroom
```

This is not a promise that Kelly is correctly specified; it is a bounded sizing proposal. It is shrunk by sample uncertainty and never overrides fixed risk limits. For SELL/exit plans, use actual follower inventory and executable bid VWAP; never convert a leader SELL into a BUY unless the binary thesis normalization is explicitly valid.

### Execution policy

1. Refresh book immediately before planning and again immediately before submission when latency is material.
2. Reject if book age, spread, drift, depth, fee, tick, minimum-size, or basket exposure fails.
3. Prefer FAK for copy entries when partial fills are acceptable and the residual must cancel. Use FOK only when an all-or-nothing position is required and the opportunity remains positive after the fill constraint.
4. Use GTC/GTD only for an explicitly declared maker strategy; never leave a copied intent resting without an expiry/cancel policy.
5. Reserve bankroll before asynchronous submission. Release unused reservation in every outcome; commit only actual accepted/final fills to exposure.
6. Reconcile `matched -> mined -> confirmed/failed` using the follower user channel/API. Unknown order status is not a successful fill and must not be retried blindly.
7. Persist leader price, planned follower price, submitted price, actual fill VWAP, fill ratio, latency, fees, rejection reason, and order ID.

### Anti-starvation policy

Quality gates must not silently turn the system off. The planner emits shadow metrics for near-misses and tracks:

```text
candidate -> reconciled -> quorum -> executable -> planned -> submitted -> filled
```

Every rejection is classified by one primary reason. Thresholds are configurable and conservative by default; no global threshold is lowered to increase activity.

## Replacement C: position state machine and exits

Each copied position has a durable state:

```text
PLANNED -> ORDERING -> PARTIAL -> OPEN -> EXIT_REQUESTED
  -> EXIT_PARTIAL -> CLOSED
  -> RESOLUTION_PENDING -> SETTLED
```

Failure/unknown states are explicit:

```text
ORDER_UNKNOWN, EXIT_UNKNOWN, RECONCILIATION_REQUIRED, HALTED
```

### Exit priority

1. **Emergency risk exit:** kill switch, invalid market, custody/settlement risk, or exposure breach.
2. **Resolution/expiry handling:** stop opening new exposure, then settle/redeem according to actual market state; do not assume redemption is automatic.
3. **Follower inventory protection:** if a position is partial or already closed, cap exit quantity to actual inventory.
4. **Value exit:** sell only when executable bid value after fees and slippage exceeds the model's hold-to-resolution value plus a required margin, or when calibrated probability/market state invalidates the thesis.
5. **Leader exit:** treat a confirmed leader SELL as evidence to re-evaluate. Mirror only the proportional quantity that exists in the follower position and only if the independent exit checks pass.
6. **Time/liquidity exit:** optional policy for capital lockup or deteriorating exit liquidity; never use a blind fixed stop without paper evidence.

### Value comparison

For current position quantity `q`:

```text
sellValue = executableBidVwap(q) * q - sellFees - impactBuffer
holdValue = q * calibratedP(win) - resolutionRiskBuffer - capitalLockCost
exit if sellValue > holdValue + requiredEdgeMargin
```

For a winning token near 1.00, the value of holding to resolution may dominate selling if liquidity is poor. For a thesis reversal, risk exit can dominate expected settlement value. Both decisions require the live book and actual inventory.

### Safe defaults

- Default exit mode: `HYBRID` in paper mode, with emergency risk and resolution handling always active.
- Leader SELL: re-evaluate, not unconditional mirror.
- No position: ignore leader SELL for execution and record `NO_INVENTORY`.
- No executable bid: keep position open, record `EXIT_LIQUIDITY_BLOCKED`, and keep capital reserved.
- Dry run simulates planned and actual fill outcomes using the book; it must not report a successful exit merely because an order was requested.

## Comparison

| Capability | Typical public bot | Polyland replacement |
|---|---|---|
| Detection | polling/activity watermark | fast candidate + authoritative reconciliation + overlap backfill |
| Identity | timestamp/tx hash, often race-prone | durable claim-before-process and canonical fallback identity |
| Copy price | leader price or one live quote | executable VWAP with depth, fees, drift, tick, latency |
| Order result | request success assumed as fill | matched/mined/confirmed/failed state reconciliation |
| Entry sizing | fixed multiplier/cap | bounded cost-adjusted edge, fractional Kelly, confidence, basket headroom |
| Exit | mirror-only, BUY-only, or marketing TP/SL | position state machine with inventory-aware leader/value/risk/resolution exits |
| Accounting | often no settlement/fees | follower fill, fee, exit, settlement, and resolution ledger |
| Starvation | hidden threshold changes | stage counters, near-miss telemetry, configurable gates |

## Acceptance tests before any live consideration

- Replay captures with duplicate, out-of-order, missing, and mismatched wallet events.
- Prove no candidate can execute twice after restart.
- Prove leader SELL with zero/partial follower inventory cannot create an accidental BUY.
- Prove planned size is never above wallet, basket, bankroll, or depth limits.
- Prove actual exposure uses confirmed fills, not submitted size.
- Prove exit cannot sell more than inventory and cannot double-count settlement.
- Prove stale/anonymous market prints cannot be attributed to a wallet.
- Run the locked forward paper gate on follower-level net results. Keep DRY RUN until it passes.

## Sources

[1] https://docs.polymarket.com/market-data/realtime-data
[2] https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
[3] https://docs.polymarket.com/api-reference/core/get-user-activity.md
[4] https://docs.polymarket.com/concepts/order-lifecycle
[5] https://quicknode.com/guides/defi/polymarket-copy-trading-bot
[6] https://github.com/snipeRun/polymarket-copy-trading-bot
[7] https://arxiv.org/abs/2604.24366
[8] https://arxiv.org/abs/1011.6402
[9] https://help.polymarket.com/en/articles/13364247-can-i-sell-early
[10] https://www.wealthsimple.com/en-ca/learn/exit-liquidity-traps-prediction-markets
[11] https://www.binance.com/en/support/faq/detail/0b3a91eea664402f812fe41358c8a206
[12] https://www.okx.com/help/copy-traders-introduction-to-proportional-copy-trading
[13] https://www.reddit.com/r/Polymarket/comments/1vannws/is_there_a_trusted_toolwebsite_to_copy_trade_on/
[14] https://www.reddit.com/r/PredictionsMarkets/comments/1te0lnl/i_stopped_copytrading_polymarket_whales_and/
