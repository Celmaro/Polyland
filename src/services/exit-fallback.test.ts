import { describe, it, expect } from 'vitest';
import { complementExitPrice, MIN_SYNTHETIC_EXIT } from './exit-fallback.js';

describe('exit-fallback complementExitPrice', () => {
  it('returns 1 - bestNoAsk when the complement side has a real ask', () => {
    // NO ask at 0.39 ⇒ YES sell price ≈ 1 - 0.39 = 0.61
    const p = complementExitPrice([{ price: 0.39, size: 100 }, { price: 0.40, size: 200 }]);
    expect(p).toBeCloseTo(0.61, 5);
  });

  it('subtracts the taker fee', () => {
    const p = complementExitPrice([{ price: 0.39, size: 100 }], 200);
    expect(p).toBeCloseTo(0.61 - 0.02, 5);
  });

  it('returns null on an empty complement book', () => {
    expect(complementExitPrice([])).toBeNull();
  });

  it('returns null when the best NO ask is degenerate (≥1)', () => {
    expect(complementExitPrice([{ price: 1.0, size: 10 }])).toBeNull();
  });

  it('returns null when the synthetic price is below the minimum (fees eat it)', () => {
    // bestNoAsk 0.995, fee 100bps → 1 - 0.995 - 0.01 = -0.005 → null
    expect(complementExitPrice([{ price: 0.995, size: 10 }], 100)).toBeNull();
  });

  it('clamps at MAX_SYNTHETIC_EXIT', () => {
    const p = complementExitPrice([{ price: 0.001, size: 1 }]);
    expect(p).toBeLessThanOrEqual(0.99);
  });

  it('handles string prices (Polymarket books return strings)', () => {
    const p = complementExitPrice([{ price: '0.39' as unknown as number, size: '100' as unknown as number }]);
    expect(p).toBeCloseTo(0.61, 5);
  });

  it('treats a null/undefined best ask as degenerate', () => {
    expect(complementExitPrice([{ price: 0 as unknown as number, size: 0 }])).toBeNull();
  });
});
