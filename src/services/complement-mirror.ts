/**
 * R2 — complement-side mirroring.
 *
 * When the target token's ask is walled (0.99) but the complement token of the
 * same binary market has real two-sided depth, express the leader's directional
 * delta via the complement at its executable price.
 *
 * Binary/neg-risk ONLY. A strict post-fee gate rejects a mirror when the
 * complement's cost (ask + taker fee) leaves no edge vs the target consensus.
 *
 * Binary delta: buying N YES ≈ notional N at consensus; the complement NO token
 * at price (1-p) carries the inverse delta. We BUY the complement token to take
 * the same directional stance (leader BUYs YES => we BUY NO at 1-consensus).
 */
export interface BookSide {
  tokenId: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  consensusPrice: number;
  targetAskBest: number;   // best ask of the target we wanted to buy
  targetBidBest?: number;
}

export interface ComplementBook {
  tokenId: string;
  complementSide: 'BUY' | 'SELL';
  complementAskBest: number;
  complementBidBest?: number;
  askSize: number;
}

export interface MirrorPlanInput {
  target: BookSide;
  complement: ComplementBook;
  takerFeeBps: number;
  minPositionUsd: number;
  maxSlippageBps: number;
}

export interface MirrorOrder {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export type MirrorResult =
  | { ok: true; order: MirrorOrder; side: 'mirrored'; complementCostPerShare: number }
  | { ok: false; reason: 'target_fillable' | 'complement_not_fillable' | 'mirror_unprofitable' | 'not_binary' };

/** For a binary market, buying one side is the complement of the other. */
export function binaryComplement(target: { tokenId: string; side: 'BUY' | 'SELL'; outcome: string }): {
  complementSide: 'BUY' | 'SELL';
  complementOutcome: string;
} {
  // We always EXECUTE a BUY on the complement token (taking the inverse side).
  return { complementSide: 'BUY', complementOutcome: target.outcome === 'Yes' ? 'No' : 'Yes' };
}

/** Strict post-fee gate: mirror only when the complement cost leaves edge. */
export function isMirrorProfitable(params: {
  complementAskBest: number;
  takerFeeBps: number;
  targetConsensusPrice: number;
  targetAskBest: number;
  maxSlippageBps: number;
}): { ok: boolean; complementCostPerShare?: number } {
  const { complementAskBest, takerFeeBps, targetConsensusPrice, targetAskBest, maxSlippageBps } = params;
  // The target is already fillable -> no mirror needed.
  if (targetAskBest <= targetConsensusPrice * (1 + maxSlippageBps / 10_000)) {
    return { ok: false };
  }
  // Complement all-in cost per share (ask + taker fee). Fee = bps * p * (1-p).
  const feePerShare = complementAskBest <= 0 || complementAskBest >= 1
    ? 0
    : (takerFeeBps / 10_000) * complementAskBest * (1 - complementAskBest);
  const complementCost = complementAskBest + feePerShare;
  // Mirror only if the complement side is meaningfully cheaper than the walled target
  // AND buying it at this price is not near-certainty (a 0.95 complement is pointless).
  const acceptable = complementAskBest < 0.9 && complementCost < targetAskBest * 0.9;
  if (!acceptable) return { ok: false };
  return { ok: true, complementCostPerShare: complementCost };
}

/** Build a fillable complement-mirror order, or explain why none exists. */
export function planComplementMirror(input: MirrorPlanInput): MirrorResult {
  const { target, complement, takerFeeBps, minPositionUsd, maxSlippageBps } = input;

  // 1. Target fillable? Then no mirror.
  const targetFillable = target.targetAskBest <= target.consensusPrice * (1 + maxSlippageBps / 10_000);
  if (targetFillable) return { ok: false, reason: 'target_fillable' };

  // 2. Complement must have real executable ask depth.
  if (!(complement.complementAskBest > 0) || !(complement.askSize > 0) || complement.complementAskBest >= 0.9) {
    return { ok: false, reason: 'complement_not_fillable' };
  }

  // 3. Post-fee profitability gate.
  const prof = isMirrorProfitable({
    complementAskBest: complement.complementAskBest,
    takerFeeBps,
    targetConsensusPrice: target.consensusPrice,
    targetAskBest: target.targetAskBest,
    maxSlippageBps,
  });
  if (!prof.ok || prof.complementCostPerShare === undefined) {
    return { ok: false, reason: 'mirror_unprofitable' };
  }

  // 4. Size: express ~the same notional delta. For a binary, buying `size`
  //    shares of the complement at price p corresponds to a comparable stake.
  const size = Math.max(minPositionUsd, minPositionUsd / Math.max(0.01, complement.complementAskBest));

  return {
    ok: true,
    order: {
      tokenId: complement.tokenId,
      side: 'BUY',
      price: complement.complementAskBest,
      size,
    },
    side: 'mirrored',
    complementCostPerShare: prof.complementCostPerShare,
  };
}