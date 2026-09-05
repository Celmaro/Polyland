import type { MarketCategory } from './smart-money-service.js';
export interface BasketRiskCaps { perWallet: number; perMarket: number; perCondition: number; perEventFamily: number; perDomain: number; }
export interface BasketRiskConfig { reservePct: number; caps: BasketRiskCaps; domainBudgetPct: Record<string, number>; }
export const DEFAULT_BASKET_RISK_CONFIG: BasketRiskConfig = {
  reservePct: 0.2,
  caps: { perWallet: 0.1, perMarket: 0.2, perCondition: 0.2, perEventFamily: 0.3, perDomain: 0.4 },
  domainBudgetPct: {},
};
export function computeBasketBudget(capital: number, config: BasketRiskConfig, category: MarketCategory | string): number {
  const available = Math.max(0, capital) * Math.max(0, 1 - config.reservePct);
  const domain = config.domainBudgetPct[category];
  return available * (domain === undefined ? 1 : Math.max(0, domain));
}
export function checkExposure(
  capitalUsd: number,
  basketSpend: number,
  inFlightReserved: number,
  config: BasketRiskConfig,
  category: MarketCategory | string,
  amountUsd: number,
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return { ok: false, reason: 'invalid_amount' };
  const budget = computeBasketBudget(capitalUsd, config, category);
  if (basketSpend + inFlightReserved + amountUsd > budget + 1e-9) {
    return { ok: false, reason: 'basket_budget_exceeded' };
  }
  return { ok: true };
}
export function covarianceShrink(target: number[][], identityMatrix: number[][], delta: number): number[][] {
  const d = Math.max(0, Math.min(1, delta));
  return target.map((row, i) => row.map((value, j) => (1 - d) * value + d * (identityMatrix[i]?.[j] ?? (i === j ? 1 : 0))));
}
