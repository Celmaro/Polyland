/**
 * PositionStateMachine — replacement exit layer for Polyland.
 *
 * Research-driven design: an exit is a decision about the follower's actual
 * inventory against the executable bid versus the model's expected settlement
 * value. It is never a blind mirror of a leader's SELL.
 *
 * States are explicit and durable; unknown order/exit states are first-class
 * so a timeout can never be mistaken for success, and settlement can never be
 * double-counted after an early exit.
 */
export type PositionState =
  | 'PLANNED'
  | 'ORDERING'
  | 'PARTIAL'
  | 'OPEN'
  | 'EXIT_REQUESTED'
  | 'EXIT_PARTIAL'
  | 'CLOSED'
  | 'RESOLUTION_PENDING'
  | 'SETTLED'
  | 'ORDER_UNKNOWN'
  | 'EXIT_UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'HALTED';

export interface Position {
  id: string;
  conditionId: string;
  tokenId?: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  /** Current follower inventory (shares). */
  shares: number;
  entryPrice: number;
  entryTime: number;
  state: PositionState;
  basket: string;
  /** Set when the market resolved while the position was open. */
  resolvedAt?: number;
  winningTokenId?: string;
  redeemedAt?: number;
  exitedAt?: number;
  exitPrice?: number;
  exitReason?: string;
  settledPnl?: number;
}

export type ExitEvent =
  | { type: 'OPENED'; shares: number; price: number; time: number }
  | { type: 'FILL'; shares?: number; state?: 'partial' | 'full' | 'failed' | 'unknown' }
  | { type: 'EXIT'; shares: number; reason: string; time: number }
  | { type: 'LEADER_EXIT'; leaderShares: number; time: number }
  | { type: 'RESOLVED'; winningTokenId: string; time: number }
  | { type: 'REDEEMED'; time: number }
  | { type: 'RISK_HALT'; reason: string; time: number }
  | { type: 'CANCEL' };

export type TransitionResult =
  | { ok: true; state: PositionState }
  | { ok: false; error: string };

const TERMINAL: ReadonlySet<PositionState> = new Set(['CLOSED', 'SETTLED', 'HALTED']);

/** Valid state transitions for the lifecycle. */
export function transition(current: PositionState, event: ExitEvent): TransitionResult {
  if (TERMINAL.has(current)) return { ok: true, state: current };
  switch (event.type) {
    case 'OPENED': {
      if (current === 'PLANNED' || current === 'ORDERING' || current === 'PARTIAL') return { ok: true, state: 'OPEN' };
      return { ok: false, error: `cannot OPEN from ${current}` };
    }
    case 'FILL': {
      if (event.state === 'failed') return { ok: true, state: 'RECONCILIATION_REQUIRED' };
      if (event.state === 'unknown') return { ok: true, state: 'ORDER_UNKNOWN' };
      if (current === 'ORDERING' || current === 'PARTIAL' || current === 'PLANNED' || current === 'EXIT_REQUESTED' || current === 'EXIT_PARTIAL') {
        if (current.startsWith('EXIT')) return { ok: true, state: event.state === 'partial' ? 'EXIT_PARTIAL' : 'CLOSED' };
        return { ok: true, state: event.state === 'partial' ? 'PARTIAL' : 'OPEN' };
      }
      return { ok: false, error: `cannot FILL from ${current}` };
    }
    case 'EXIT': {
      if (current === 'OPEN' || current === 'PARTIAL') return { ok: true, state: 'EXIT_REQUESTED' };
      return { ok: false, error: `cannot EXIT from ${current}` };
    }
    case 'LEADER_EXIT': {
      // A leader exit is a re-evaluation trigger, not a state change by itself.
      if (current === 'OPEN' || current === 'PARTIAL') return { ok: true, state: current };
      return { ok: true, state: current };
    }
    case 'RISK_HALT': {
      return { ok: true, state: 'HALTED' };
    }
    case 'RESOLVED': {
      if (current === 'OPEN' || current === 'PARTIAL' || current === 'EXIT_PARTIAL' || current === 'EXIT_REQUESTED') {
        return { ok: true, state: 'RESOLUTION_PENDING' };
      }
      return { ok: false, error: `cannot RESOLVE from ${current}` };
    }
    case 'REDEEMED': {
      if (current === 'RESOLUTION_PENDING') return { ok: true, state: 'SETTLED' };
      return { ok: false, error: `cannot REDEEM from ${current}` };
    }
    case 'CANCEL': {
      return { ok: true, state: 'PLANNED' };
    }
    default:
      return { ok: false, error: 'unknown_event' };
  }
}

export interface ExitEvaluationInput {
  inventoryShares: number;
  executableBidVwap: number;
  /** Post-sale fee per share. */
  sellFeePerShare: number;
  /** Follower impact/slippage buffer per share. */
  impactBufferPerShare: number;
  /** Calibrated probability the follower's token wins (0..1). */
  fairProb: number;
  /** Risk buffer on holding (oracle/data risk), per share. */
  holdingRiskBufferPerShare?: number;
  /** Required edge margin for selling vs holding, per share. */
  requiredMarginPerShare?: number;
  /** Set when the leader confirmed a SELL of the same market/side. */
  leaderExit?: { leaderShares: number; confirmed: boolean };
  /** Market is resolved and this token won. */
  resolvedWinning?: boolean;
  riskHalt?: boolean;
}

export type ExitAction =
  | { action: 'HOLD'; reason: string }
  | { action: 'SELL'; quantity: number; reason: string }
  | { action: 'RESOLVE'; quantity: number; reason: string }
  | { action: 'RISK_EXIT'; quantity: number; reason: string }
  | { action: 'NO_INVENTORY'; reason: string };

/**
 * Decide whether to exit. Never sells more than actual inventory; a leader
 * SELL is only a re-evaluation trigger, never an unconditional mirror; a
 * resolved winner is redeemed, not sold.
 */
export function evaluateExit(input: ExitEvaluationInput): ExitAction {
  const inv = Math.max(0, input.inventoryShares);
  if (inv <= 0) return { action: 'NO_INVENTORY', reason: 'no_position' };

  if (input.riskHalt) return { action: 'RISK_EXIT', quantity: inv, reason: 'risk_halt' };
  if (input.resolvedWinning) return { action: 'RESOLVE', quantity: inv, reason: 'winning_resolved' };

  const sellValue = (input.executableBidVwap - input.sellFeePerShare - input.impactBufferPerShare) * inv;
  const holdValue = (input.fairProb - (input.holdingRiskBufferPerShare ?? 0)) * inv;
  const margin = input.requiredMarginPerShare ?? 0;

  // A confirmed leader exit re-evaluates first and caps the exit quantity at
  // the leader's proportional reduction; it is never an unconditional mirror.
  if (input.leaderExit?.confirmed) {
    const leaderQty = Math.min(input.leaderExit.leaderShares, inv);
    if (leaderQty > 0 && sellValue > holdValue) {
      return { action: 'SELL', quantity: leaderQty, reason: 'leader_exit' };
    }
    if (leaderQty > 0) {
      return { action: 'HOLD', reason: 'leader_exit_but_value_prefers_hold' };
    }
  }

  if (sellValue > holdValue + margin * inv) {
    return { action: 'SELL', quantity: inv, reason: 'value_exit' };
  }

  return { action: 'HOLD', reason: 'hold_value_dominates' };
}

/** State machine over one copied position. */
export class PositionStateMachine {
  constructor(private readonly positions = new Map<string, Position>()) {}

  get(id: string): Position | undefined {
    return this.positions.get(id);
  }

  open(position: Position): void {
    this.positions.set(position.id, { ...position, state: 'PLANNED' });
  }

  /** Apply an event; returns the new state or throws on invalid transition. */
  apply(id: string, event: ExitEvent): PositionState {
    const p = this.positions.get(id);
    if (!p) throw new Error(`position ${id} not found`);
    const t = transition(p.state, event);
    if (!t.ok) throw new Error(`invalid transition on ${id}: ${t.error}`);
    const next: Position = { ...p, state: t.state };
    if (event.type === 'RESOLVED') {
      next.resolvedAt = event.time;
      next.winningTokenId = event.winningTokenId;
    }
    if (event.type === 'REDEEMED') next.redeemedAt = event.time;
    if (event.type === 'RISK_HALT') next.exitReason = event.reason;
    if (event.type === 'EXIT') {
      next.exitReason = event.reason;
    }
    // Inventory updates on fills and exits.
    if (event.type === 'FILL' && event.state !== 'failed' && event.state !== 'unknown') {
      const fillShares = event.shares ?? 0;
      if (p.state === 'ORDERING' || p.state === 'PARTIAL' || p.state === 'OPEN' || p.state === 'PLANNED') next.shares += fillShares;
      if (p.state === 'EXIT_REQUESTED' || p.state === 'EXIT_PARTIAL') next.shares = Math.max(0, next.shares - fillShares);
      if (next.shares <= 0 && (p.state === 'EXIT_REQUESTED' || p.state === 'EXIT_PARTIAL')) next.state = 'CLOSED';
    }
    this.positions.set(id, next);
    return next.state;
  }
}