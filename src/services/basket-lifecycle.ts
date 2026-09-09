/**
 * Basket lifecycle (A1–A5): self-maintaining wallet memberships.
 *
 * A1 — graduated, reversible lifecycle actions (add/remove/suspend/observe)
 *       with explicit reasons (never a hard blacklist).
 * A2 — churn + capacity bounds: max_wallets_per_basket, max_new_wallets_per_run,
 *       and a promotion buffer (must clear score threshold + buffer).
 * A3 — persisted memberships with tier/rank/active/effective_until; stale
 *       contributors expire.
 * A4 — target-allocation rebalancing advisory (concentration control).
 * A5 — basket overlap health snapshot (independent-vote observable).
 */
import type { MarketCategory } from './smart-money-service.js';
// MarketCategory imported for the re-export above is not used at runtime here.

export type BasketTier = 'core' | 'rotating' | 'backup' | 'explorer';

export interface BasketMembership {
  topic: string;
  wallet: string; // lowercased
  tier: BasketTier;
  rank: number;
  active: boolean;
  joinedAt: number;
  effectiveUntil: number | null;
  promotionReason: string;
  demotionReason: string;
}

export interface BasketLifecycleConfig {
  maxWalletsPerBasket: number;
  maxNewWalletsPerRun: number;
  minAssignmentScore: number;
  promotionBuffer: number;
  rebalanceDriftThreshold?: number;
  targetAllocationByTopic?: Record<string, number>;
}

export type LifecycleActionKind = 'add' | 'remove' | 'suspend' | 'observe' | 'rebalance';

export interface LifecycleAction {
  action: LifecycleActionKind;
  topic: string;
  wallet: string;
  score: number;
  reason: string;
}

export interface WalletAssignment {
  wallet: string;
  topic: string;
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const TIER_ORDER: BasketTier[] = ['core', 'rotating', 'backup', 'explorer'];

export class BasketWalletManager {
  private memberships = new Map<string, BasketMembership>(); // key `${topic}:${wallet}`
  private saveCallback: ((memberships: BasketMembership[]) => void) | null = null;
  private newWalletsThisRun = 0;

  constructor(
    private readonly config: BasketLifecycleConfig,
    currentByTopic?: Record<string, BasketMembership[]>,
  ) {
    for (const topic of Object.keys(currentByTopic ?? {})) {
      for (const m of currentByTopic![topic]) this.memberships.set(key(topic, m.wallet), m);
    }
  }

  onSave(cb: (memberships: BasketMembership[]) => void): void {
    this.saveCallback = cb;
  }

  /** Restore persisted memberships. */
  restore(memberships: BasketMembership[]): void {
    this.memberships.clear();
    for (const m of memberships) this.memberships.set(key(m.topic, m.wallet), { ...m });
  }

  membershipSnapshot(): BasketMembership[] {
    const now = Date.now();
    // prune expired memberships
    for (const [k, m] of this.memberships) {
      if (m.effectiveUntil !== null && m.effectiveUntil <= now) this.memberships.delete(k);
    }
    return [...this.memberships.values()].sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.rank - b.rank || a.wallet.localeCompare(b.wallet),
    );
  }

  private currentByTopic(): Map<string, BasketMembership[]> {
    const byTopic = new Map<string, BasketMembership[]>();
    for (const m of this.membershipSnapshot()) {
      const list = byTopic.get(m.topic) ?? [];
      list.push(m);
      byTopic.set(m.topic, list);
    }
    return byTopic;
  }

  /**
   * Propose lifecycle actions from scored wallet assignments (A1/A2).
   * Deterministic; highest score first. Returns actions in priority order.
   */
  propose(assignments: WalletAssignment[]): LifecycleAction[] {
    this.newWalletsThisRun = 0;
    const actions: LifecycleAction[] = [];
    const byTopic = this.currentByTopic();
    const plannedAdds = new Set<string>();

    for (const a of [...assignments].sort((x, y) => y.score - x.score)) {
      const wallet = a.wallet.toLowerCase();
      const membership = this.memberships.get(key(a.topic, wallet));
      const threshold = this.config.minAssignmentScore;

      if (membership) {
        // existing wallet lifecycle (A1): degrade -> suspend/remove, else no-op
        if (a.score < threshold) {
          actions.push({ action: 'suspend', topic: a.topic, wallet, score: a.score, reason: `existing wallet score degraded below threshold (${a.score.toFixed(2)} < ${threshold})` });
        } else if (a.confidence === 'LOW') {
          actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: 'existing wallet confidence fell to LOW' });
        }
        continue;
      }

      // new wallet
      if (a.score < threshold) {
        actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: 'below assignment score threshold' });
        continue;
      }
      if (a.confidence === 'LOW') {
        actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: 'low confidence assignment' });
        continue;
      }
      // promotion buffer (A2): HIGH clears immediately, else must clear threshold+buffer
      const bufferTarget = threshold + this.config.promotionBuffer;
      if (a.confidence !== 'HIGH' && a.score < bufferTarget) {
        actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: `below promotion quality buffer (${a.score.toFixed(2)} < ${bufferTarget.toFixed(2)})` });
        continue;
      }
      // capacity (A2)
      const current = (byTopic.get(a.topic) ?? []).filter((m) => m.active).length;
      if (current >= this.config.maxWalletsPerBasket) {
        actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: 'basket is at max wallet capacity' });
        continue;
      }
      if (plannedAdds.has(a.topic) && this.newWalletsThisRun >= this.config.maxNewWalletsPerRun) {
        actions.push({ action: 'observe', topic: a.topic, wallet, score: a.score, reason: 'max new wallets per run reached' });
        continue;
      }
      // add
      this.addMembership(a.topic, wallet, a.score);
      this.newWalletsThisRun++;
      plannedAdds.add(a.topic);
      actions.push({ action: 'add', topic: a.topic, wallet, score: a.score, reason: `added at score ${a.score.toFixed(2)}` });
    }
    this.persist();
    return actions;
  }

  private addMembership(topic: string, wallet: string, score: number): void {
    const byTopic = this.currentByTopic().get(topic) ?? [];
    const rank = byTopic.length + 1;
    this.memberships.set(key(topic, wallet), {
      topic,
      wallet,
      tier: 'core',
      rank,
      active: true,
      joinedAt: Date.now(),
      effectiveUntil: null,
      promotionReason: `added at score ${score.toFixed(2)}`,
      demotionReason: '',
    });
  }

  /** Apply a lifecycle action to the membership set (A3 persist). */
  applyAction(action: LifecycleAction): void {
    const k = key(action.topic, action.wallet);
    if (action.action === 'add') this.addMembership(action.topic, action.wallet, action.score);
    else if (action.action === 'remove') this.memberships.delete(k);
    else if (action.action === 'suspend') {
      const m = this.memberships.get(k);
      if (m) { m.active = false; m.demotionReason = action.reason; }
    }
    this.persist();
  }

  private persist(): void {
    this.saveCallback?.(this.membershipSnapshot());
  }
}

/** A4 — target-allocation rebalancing advisory. */
export function evaluateRebalance(
  config: BasketLifecycleConfig,
  exposureByTopic: Record<string, number>,
): LifecycleAction[] {
  const targets = config.targetAllocationByTopic ?? {};
  const totalTarget = Object.values(targets).reduce((s, v) => s + v, 0);
  if (totalTarget <= 0) return [];
  const totalExposure = Object.values(exposureByTopic).reduce((s, v) => s + v, 0);
  if (totalExposure <= 0) return [];
  const driftThreshold = config.rebalanceDriftThreshold ?? 0.05;
  const actions: LifecycleAction[] = [];
  for (const [topic, targetAlloc] of Object.entries(targets)) {
    if (targetAlloc <= 0) continue;
    const targetExposure = totalExposure * (targetAlloc / totalTarget);
    const currentExposure = exposureByTopic[topic] ?? 0;
    const drift = targetExposure > 0 ? Math.abs(currentExposure - targetExposure) / targetExposure : 0;
    if (drift > driftThreshold) {
      actions.push({ action: 'rebalance', topic, wallet: '', score: 0, reason: `allocation drift ${(drift * 100).toFixed(0)}% exceeds threshold` });
    }
  }
  return actions;
}

/** A5 — basket overlap health snapshot. */
export interface BasketOverlapHealth {
  activeTokens: number;
  tokensAtLeast2: number;
  tokensAtLeast3: number;
  tokensAtLeast4: number;
  overlapPct2: number;
  overlapPct3: number;
  overlapPct4: number;
}

export function computeBasketOverlapHealth(votesByToken: Map<string, ReadonlySet<string>>): BasketOverlapHealth {
  const counts = [...votesByToken.values()].map((s) => s.size).filter((n) => n > 0);
  const activeTokens = counts.length;
  const atLeast = (n: number) => counts.filter((c) => c >= n).length;
  const pct = (v: number) => (activeTokens > 0 ? Number(((v / activeTokens) * 100).toFixed(2)) : 0);
  return {
    activeTokens,
    tokensAtLeast2: atLeast(2),
    tokensAtLeast3: atLeast(3),
    tokensAtLeast4: atLeast(4),
    overlapPct2: pct(atLeast(2)),
    overlapPct3: pct(atLeast(3)),
    overlapPct4: pct(atLeast(4)),
  };
}

function key(topic: string, wallet: string): string {
  return `${topic}:${wallet.toLowerCase()}`;
}

// Basin type import only used in the BasketMembership type; re-export for consumers.
export type { MarketCategory };
