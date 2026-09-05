# Progress — trade detection/copy/exit task

## 2026-09-05
- Started from local commit `06a6498`; GitHub main remains unmodified at `3937ad41...`.
- Loaded using-agent-skills, planning-with-files, context-engineering, scrapling, grounded-citations, TDD, systematic-debugging, incremental implementation, subagent-driven development, GitHub, and Hermes guidance.
- Direct grounding confirms Polymarket `last_trade_price` market events do not identify the trader; wallet-level detection must use the Activity/Data API surface currently used by Polyland.
- Current `SmartMoneyTrade` fields: traderAddress, side, size, price, conditionId, marketSlug, tokenId, outcome, txHash, timestamp, isSmartMoney.
- Current `ExecutionEngine` evaluates quorum signals but executes BUY only; it has risk, bankroll reservation, tick quantization, fee/edge/liquidity gates and an `onPositionOpened` callback. Exit execution is not yet present.
- Research fleet: five parallel agents covering official Polymarket mechanics, public copy bots, CeFi copy trading, academic execution/exit research, and last30days social research.
- Known environment limitation: system Python is 3.11.9; uv 0.12.7 is available for a Python 3.12 attempt. No relevant research API keys are exposed in the shell environment.

## Errors
| Error | Attempt | Resolution |
|---|---|---|
| GitHub direct push connection reset | direct `git push origin main` | Not retried; remote publication remains separate and is not part of this task yet |
| Execution-engine regex search parse error | compound regex | Replaced with direct file read |
