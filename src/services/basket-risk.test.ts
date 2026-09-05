import { describe, expect, it } from 'vitest';
import { DEFAULT_BASKET_RISK_CONFIG, checkExposure, computeBasketBudget, covarianceShrink } from './basket-risk.js';
describe('basket risk budgets', () => {
  it('applies reserve before domain budget', () => expect(computeBasketBudget(1000, { ...DEFAULT_BASKET_RISK_CONFIG, domainBudgetPct: { crypto: .5 } }, 'crypto')).toBe(400));
  it('rejects over-allocation accounting for spent + in-flight', () => {
    expect(checkExposure(800, 100, 50, DEFAULT_BASKET_RISK_CONFIG, 'other', 100).ok).toBe(true);
    expect(checkExposure(800, 100, 50, DEFAULT_BASKET_RISK_CONFIG, 'other', 501).ok).toBe(false);
  });
  it('shrinks covariance toward identity', () => expect(covarianceShrink([[2, .5], [.5, 3]], [[1, 0], [0, 1]], .5)).toEqual([[1.5, .25], [.25, 2]]));
});
