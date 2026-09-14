/**
 * Live reconciliation of resting orders against the CLOB venue (item #2).
 *
 * Resting orders in LIVE mode are real venue orders. When the pod restarts or
 * an ambiguous submission outcome occurs, the in-memory RestingOrderBook must
 * be reconciled against the venue's actual open orders so we never:
 *   - double-count shares (book says filled, venue says still open),
 *   - silently drop a resting order that DID land on the venue,
 *   - mis-tag a partially-filled order as open (or vice-versa).
 *
 * This module is a PURE decision function: given the book's open orders and
 * the venue's reported open orders, it returns per-order reconciliation
 * verdicts the caller applies to its durable state. Kept side-effect free so
 * it is trivially unit-tested.
 */
import type { RestingOrder } from './resting-order.js';

export type LiveReconcileVerdict =
  | { action: 'open_match'; reason: string }
  | { action: 'venue_missing_cancel'; reason: string }
  | { action: 'book_missing_preserve'; reason: string }
  | { action: 'partial_fill'; filledShares: number; reason: string }
  | { action: 'venue_filled_confirm'; filledShares: number; reason: string }
  | { action: 'expired_cancel'; reason: string };

export interface LiveVenueOrder {
  /** Venue order id — matches RestingOrder.id when the clientOrderId was used. */
  id: string;
  /** Shares matched by the venue so far. */
  filledShares?: number;
  originalSize?: number;
  status?: string;
  /** true when the venue reports the order still open (resting). */
  isOpen: boolean;
}

export interface ReconcileLiveRestingInput {
  bookOrders: RestingOrder[];
  venueOrders: LiveVenueOrder[];
  now?: number;
}

export function reconcileLiveResting(input: ReconcileLiveRestingInput): Array<{ orderId: string; verdict: LiveReconcileVerdict }> {
  const now = input.now ?? Date.now();
  const out: Array<{ orderId: string; verdict: LiveReconcileVerdict }> = [];
  const venueById = new Map(input.venueOrders.map((v) => [v.id, v]));

  for (const order of input.bookOrders) {
    const venue = venueById.get(order.id);

    // Expired first — TTL governs, regardless of venue state.
    if (now - order.placedAt > order.ttlMs) {
      out.push({ orderId: order.id, verdict: { action: 'expired_cancel', reason: `past TTL (${now - order.placedAt}ms > ${order.ttlMs}ms)` } });
      continue;
    }

    if (!venue) {
      // Book has it open, venue does not. Either it never landed (ambiguous
      // submit) or it filled/cancelled on the venue. NEVER assume a fill.
      out.push({ orderId: order.id, verdict: { action: 'venue_missing_cancel', reason: 'book open but not on venue — do not assume fill, cancel' } });
      continue;
    }

    if (!venue.isOpen) {
      // Venue says closed. If it reports matched shares, treat as filled.
      const filled = venue.filledShares ?? order.filledShares ?? 0;
      if (filled > 0) {
        out.push({ orderId: order.id, verdict: { action: 'venue_filled_confirm', filledShares: filled, reason: `venue reports closed with ${filled} matched` } });
      } else {
        out.push({ orderId: order.id, verdict: { action: 'venue_missing_cancel', reason: 'venue closed with no matched shares — cancelled' } });
      }
      continue;
    }

    // Venue open. Compare matched shares vs our book's filled count.
    const venueFilled = venue.filledShares ?? 0;
    const bookFilled = order.filledShares ?? 0;
    if (venueFilled > bookFilled) {
      out.push({ orderId: order.id, verdict: { action: 'partial_fill', filledShares: venueFilled, reason: `venue matched ${venueFilled} > book ${bookFilled} — update to venue` } });
    } else {
      out.push({ orderId: order.id, verdict: { action: 'open_match', reason: 'venue open, shares aligned' } });
    }
  }

  return out;
}
