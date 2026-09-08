/**
 * reconciliation tests — startup restore + reconcile of durable order
 * records and open positions (P0-5/P0-7). DRY-RUN semantics: an order whose
 * position record exists is FILLED; an orphaned PENDING/UNKNOWN order is
 * conservatively CANCELLED (reservation released). Any leftover unknown
 * state after the sweep means reconciliation FAILED and copy decisions must
 * not resume until the operator resolves it.
 */
import { describe, it, expect } from 'vitest';
import { reconcileDryRunOrders, type ReconcileDryRunInput } from './reconciliation.js';
import type { OrderLifecycleRecord } from './state-store.js';

const positionIds = new Set(['token-1', 'token-2']);

function order(id: string, status: OrderLifecycleRecord['status'], updatedAt = 100): OrderLifecycleRecord {
  return { id, positionId: id, status, updatedAt };
}

describe('reconcileDryRunOrders (P0-5/P0-7)', () => {
  it('resolves PENDING with a matching position to FILLED', () => {
    const r = reconcileDryRunOrders({ orders: [order('token-1', 'PENDING')], positionIds });
    expect(r.ok).toBe(true);
    expect(r.resolved[0].status).toBe('FILLED');
    expect(r.pendingOrders).toBe(0);
  });

  it('conservatively CANCELLES an orphaned PENDING/UNKNOWN order (no position)', () => {
    const r = reconcileDryRunOrders({ orders: [order('token-9', 'PENDING'), order('token-10', 'UNKNOWN')], positionIds });
    expect(r.ok).toBe(true); // resolvable: both sweep to CANCELLED
    expect(r.resolved.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('leaves terminal records untouched (FILLED/CANCELLED stay)', () => {
    const r = reconcileDryRunOrders({
      orders: [order('token-1', 'FILLED'), order('token-2', 'CANCELLED')],
      positionIds,
    });
    expect(r.ok).toBe(true);
    expect(r.resolved.map((o) => o.status)).toEqual(['FILLED', 'CANCELLED']);
  });

  it('fails reconciliation when a PARTIAL fill cannot be resolved to a position match', () => {
    // PARTIAL is a valid live outcome, but in the DRY-RUN restore path an
    // unresolved PARTIAL with no matching position is not auto-sweepable:
    // it means the resumption would duplicate or skip shares.
    const r = reconcileDryRunOrders({ orders: [order('token-1', 'PARTIAL')], positionIds: new Set() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('PARTIAL');
  });

  it('reports counts and ok=true on a clean empty state', () => {
    const r = reconcileDryRunOrders({ orders: [], positionIds: new Set() });
    expect(r.ok).toBe(true);
    expect(r.positions).toBe(0);
    expect(r.pendingOrders).toBe(0);
  });
});