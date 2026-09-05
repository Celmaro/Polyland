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
