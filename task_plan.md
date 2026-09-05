# Polyland confidence-aware implementation plan

## Scope
Implement phases 1-5 from findings.md as the sole paper strategy:
1. Event-sourced candidate/decision ledger and corrected funnel counters.
2. Point-in-time wallet metrics and confidence-aware CopyScore.
3. Point-in-time replay/evaluation tooling and data contracts.
4. Independence-aware quorum and basket risk budgets.
5. Locked forward paper validation gates and operator reporting.

## Safety boundaries
- Keep DRY_RUN active; do not enable live trading.
- Preserve risk halts, deduplication, audit, settlement, tier floors, and bankroll limits.
- No claims of profitability until resolved paper evidence passes gates.
- No destructive deletion of legacy persistence during migration.

## Acceptance
- New behavior has regression tests written before implementation where practical.
- TypeScript, full Vitest, build, ESM startup smoke, and fresh Zeabur logs pass.
- Every phase is wired into bot-config production path, not only exported as a helper.
- Operator-visible score components and rejection reasons are persisted.

## Current phase
Baseline reconciliation.

## Errors
| Error | Attempt | Resolution |
|---|---|---|
| last30days requires Python 3.12+; host has 3.11.9 | direct run | external research completed with Tavily/Firecrawl/web_extract; no install during implementation |


## Replacement task: trade detection, copy, and exit

Implement the replacement specified in `trade-execution-design.md` rather than tuning the current Activity-only/BUY-only/heuristic path.

1. `trade-detector`: candidate intake, durable identity key, dedup claim, overlap reconciliation contract, aggregation, explicit rejection reasons.
2. `copy-planner`: executable VWAP/depth/fee/drift plan, bounded fractional-Kelly sizing, FAK/FOK policy, actual-fill accounting contract.
3. `position-state-machine`: inventory-aware leader/value/risk/resolution exits, partial and unknown order states, no accidental reverse trades.
4. Integration: wire detector before quorum, planner at execution boundary, state machine at open/exit/settlement; preserve existing safeguards.
5. Verification: TDD module suites, full Vitest, tsc, build, ESM smoke; no live deployment or DRY_RUN change.

## Replacement design status
- Research: complete; Firecrawl search was rate-limited, so official direct extraction, Tavily, web extraction, GitHub, arXiv, and last30days outputs were used.
- Design: complete in `trade-execution-design.md`.
- Implementation: pending.
- Publication: blocked until explicit approval; remote main remains unchanged.
