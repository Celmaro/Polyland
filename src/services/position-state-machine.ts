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
  | { type: 'OPENED'; shares: number; price: number; time: number; eventId?: string }
  | { type: 'FILL'; shares?: number; state?: 'partial' | 'full' | 'failed' | 'unknown'; eventId?: string }
  | { type: 'EXIT'; shares: number; reason: string; time: number; eventId?: string }
  | { type: 'LEADER_EXIT'; leaderShares: number; time: number; eventId?: string }
  | { type: 'RESOLVED'; winningTokenId: string; time: number; eventId?: string }
  | { type: 'REDEEMED'; time: number; eventId?: string }
  | { type: 'RISK_HALT'; reason: string; time: number; eventId?: string }
  | { type: 'CANCEL'; eventId?: string };

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
  entryPrice?: number;
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
  /** Maximum tolerated loss from entry before a risk exit (decimal, e.g. 0.35). */
  maxAdverseMovePct?: number;
  /** Seconds until market expiry — scales the adverse-move tolerance (short horizon → tighter). */
  secondsToExpiry?: number;
  /** Current bid-ask spread of the book — drives the value-exit hysteresis. */
  bookSpread?: number;
  /** Explicit exit hysteresis per share; defaults to max(2c, halfSpread). */
  exitHysteresisPerShare?: number;
  /** Set when the confirmed leader exit is available. */
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

  // Bounded adverse-move loss cut. The tolerance shrinks with time remaining:
  // a sub-hour binary has no recovery path, so allow −10% immediately after
  // entry and widen toward the 35% cap only for long-horizon positions
  // (audit: entries 0.85 → 0.04 with the flat 35% cap never risk-exited).
  if (input.entryPrice !== undefined && input.entryPrice > 0) {
    let maxAdverse = input.maxAdverseMovePct ?? 0.35;
    if (input.secondsToExpiry !== undefined) {
      // −10% floor, linear widening to maxAdverse over 60 minutes.
      const scaled = Math.min(maxAdverse, 0.10 + (input.secondsToExpiry / 3600) * 0.25);
      maxAdverse = Math.min(maxAdverse, scaled);
    }
    if (input.executableBidVwap <= input.entryPrice * (1 - maxAdverse)) {
      return { action: 'RISK_EXIT', quantity: inv, reason: 'adverse_move' };
    }
  }

  const sellFee = input.sellFeePerShare ?? 0;
  const impact = input.impactBufferPerShare ?? 0;
  const sellValue = (input.executableBidVwap - sellFee - impact) * inv;
  const holdBuffer = input.holdingRiskBufferPerShare ?? 0;
  const holdValue = (input.fairProb - holdBuffer) * inv;
  const margin = input.requiredMarginPerShare ?? 0;

  // A confirmed leader/reverse-quorum exit is an INFORMATION event, not an
  // arithmetic one: the wallets that justified the entry have flipped. It
  // bypasses the value comparison (which in a wide-spread thin book would
  // prefer holding all the way to zero) and caps quantity at the leader's
  // proportional reduction — never an unconditional mirror.
  if (input.leaderExit?.confirmed && input.leaderExit.leaderShares > 0) {
    const leaderQty = Math.min(input.leaderExit.leaderShares, inv);
    return { action: 'SELL', quantity: leaderQty, reason: 'leader_exit' };
  }

  // Value exit with hysteresis: the sell side must beat the hold side by MORE
  // than one tick of spread noise. Without this, every tight-spread book
  // (halfSpread < 1.5c − fee) triggers a −1-tick dump that donates the full
  // round-trip spread + fee to the market maker (audit: 8/8 exits −1 tick).
  const spread = input.bookSpread ?? 0;
  const hysteresis = input.exitHysteresisPerShare ?? Math.max(0.02, spread / 2);
  if (sellValue > holdValue + margin * inv + hysteresis * inv) {
    return { action: 'SELL', quantity: inv, reason: 'value_exit' };
  }

  return { action: 'HOLD', reason: 'hold_value_dominates' };
}

/** State machine over one copied position. */
export class PositionStateMachine {
  /** Upper bound on the in-memory dedup set (bounded cardinality). */
  private static readonly MAX_APPLIED_EVENTS = 50_000;
  private readonly appliedEvents = new Set<string>();
  constructor(private readonly positions = new Map<string, Position>()) {}

  get(id: string): Position | undefined {
    return this.positions.get(id);
  }

  all(): Position[] { return [...this.positions.values()].map(p => ({ ...p })); }

  restore(positions: Position[]): void {
    for (const p of positions) this.positions.set(p.id, { ...p });
  }

  open(position: Position): void {
    this.positions.set(position.id, { ...position, state: 'PLANNED' });
  }

  /** Apply an event idempotently; duplicate lifecycle deliveries are no-ops. */
  apply(id: string, event: ExitEvent): PositionState {
    const p = this.positions.get(id);
    if (!p) throw new Error(`position ${id} not found`);
    if (event.eventId && this.appliedEvents.has(event.eventId)) return p.state;
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
    if (event.eventId) {
      this.appliedEvents.add(event.eventId);
      // Bounded dedup memory: beyond the cap, drop the set (older duplicates
      // may re-apply once, which the durable order records still reconcile).
      if (this.appliedEvents.size > PositionStateMachine.MAX_APPLIED_EVENTS) this.appliedEvents.clear();
    }
    return next.state;
  }
}
