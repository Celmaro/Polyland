/**
 * reconciliation.ts — startup restore + reconcile of durable order records
 * and open positions (P0-5/P0-7).
 *
 * DRY-RUN restore semantics (deterministic, fail-safe):
 *   - PENDING order + matching open position → FILLED (the position exists,
 *     so the dry-run order clearly landed).
 *   - PENDING/UNKNOWN order with NO matching position → CANCELLED with the
 *     reservation released (fail-safe: never assume a fill that has no
 *     position record — assuming a fill would duplicate shares).
 *   - PARTIAL without a matching position → NOT auto-resolvable. In live this
 *     needs a venue order-status query; in dry-run it signals a broken state
 *     and MUST block copy decisions until an operator resolves it.
 *
 * The gate contract (P0-7): `ok === false` means copy decisions stay blocked.
 */
import type { OrderLifecycleRecord, ReconciliationResult } from './state-store.js';

export interface ReconcileDryRunInput {
  orders: OrderLifecycleRecord[];
  positionIds: ReadonlySet<string>;
  now?: number;
}

export interface DryRunReconciliation extends ReconciliationResult {
  /** The reconciled order set (resolved rows updated, terminal rows kept). */
  resolved: OrderLifecycleRecord[];
}

export function reconcileDryRunOrders(input: ReconcileDryRunInput): DryRunReconciliation {
  const now = input.now ?? Date.now();
  const resolved: OrderLifecycleRecord[] = [];
  let pending = 0; // remaining unresolved AFTER the sweep (0 = clean)

  for (const record of input.orders) {
    const hasPosition = input.positionIds.has(record.positionId);
    switch (record.status) {
      case 'PENDING':
      case 'UNKNOWN': {
        // Deterministic dry-run sweep: position match → FILLED, else CANCELLED.
        resolved.push({
          ...record,
          status: hasPosition ? 'FILLED' : 'CANCELLED',
          updatedAt: now,
        });
        break;
      }
      case 'PARTIAL':
        if (!hasPosition) {
          // Cannot safely auto-resolve a partial fill to no position.
          return {
            ok: false,
            checkedAt: now,
            positions: input.positionIds.size,
            pendingOrders: pending,
            resolved,
            error: `PARTIAL order ${record.id} (position ${record.positionId}) has no matching position — requires operator/venue reconciliation`,
          };
        }
        resolved.push(record);
        break;
      default:
        // FILLED / CANCELLED / RECONCILIATION_REQUIRED: terminal, keep as-is.
        resolved.push(record);
    }
  }

  return {
    ok: true,
    checkedAt: now,
    positions: input.positionIds.size,
    pendingOrders: pending,
    resolved,
  };
}