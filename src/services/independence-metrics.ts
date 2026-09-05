import type { WalletAction } from './pipeline-types.js';
export type WalletActionCategory = Pick<WalletAction, 'wallet' | 'marketSlug' | 'timestamp' | 'side' | 'outcome' | 'conditionId' | 'size' | 'price'> & {
  category?: string;
};
export interface IndependenceLimits { maxHHI: number; minNEffective: number; }
export interface ContributorCluster { wallets: string[]; actions: WalletActionCategory[]; weight: number; }
export interface ContributorSummary {
  nEff: number; hhi: number; clusters: ContributorCluster[];
  dominantWalletWeight: number; capPct: number;
}
export function computeHHI(weights: number[]): number {
  const positive = weights.map(Number).filter(Number.isFinite).map(w => Math.max(0, w));
  const total = positive.reduce((a, b) => a + b, 0);
  return total <= 0 ? 0 : positive.reduce((sum, w) => sum + (w / total) ** 2, 0);
}
export function nEffective(weights: number[]): number {
  const hhi = computeHHI(weights);
  return hhi <= 0 ? 0 : 1 / hhi;
}
export function isDiverse(hhi: number, nEff: number, limits: IndependenceLimits): boolean {
  return hhi <= limits.maxHHI && nEff >= limits.minNEffective;
}
export function jaccardOverlap(a: WalletActionCategory[], b: WalletActionCategory[]): number {
  const setA = new Set(a.map(x => x.marketSlug || x.conditionId || x.category || ''));
  const setB = new Set(b.map(x => x.marketSlug || x.conditionId || x.category || ''));
  setA.delete(''); setB.delete('');
  const union = new Set([...setA, ...setB]).size;
  if (!union) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  return intersection / union;
}
export function timingCorrelation(timesA: number[], timesB: number[], windowMs: number): number {
  if (!timesA.length || !timesB.length || windowMs <= 0) return 0;
  let close = 0;
  for (const a of timesA) if (timesB.some(b => Math.abs(a - b) <= windowMs)) close++;
  return close / Math.max(timesA.length, timesB.length);
}
export function clusterOf(actions: WalletActionCategory[], threshold: number): ContributorCluster[] {
  const byWallet = new Map<string, WalletActionCategory[]>();
  for (const action of actions) {
    const wallet = action.wallet.toLowerCase();
    const list = byWallet.get(wallet) ?? [];
    list.push(action); byWallet.set(wallet, list);
  }
  const wallets = [...byWallet.keys()];
  const parent = new Map(wallets.map(w => [w, w]));
  const root = (w: string): string => { const p = parent.get(w)!; if (p !== w) parent.set(w, root(p)); return parent.get(w)!; };
  const join = (a: string, b: string) => { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(rb, ra); };
  for (let i = 0; i < wallets.length; i++) for (let j = i + 1; j < wallets.length; j++) {
    const a = byWallet.get(wallets[i])!, b = byWallet.get(wallets[j])!;
    const overlap = jaccardOverlap(a, b);
    const timing = timingCorrelation(a.map(x => x.timestamp), b.map(x => x.timestamp), 5 * 60 * 1000);
    const sameSide = a.some(x => b.some(y => x.side === y.side && (x.outcome === y.outcome || x.conditionId === y.conditionId))) ? 1 : 0;
    if ((overlap + timing + sameSide) / 3 >= threshold) join(wallets[i], wallets[j]);
  }
  const groups = new Map<string, ContributorCluster>();
  for (const wallet of wallets) { const key = root(wallet); const group = groups.get(key) ?? { wallets: [], actions: [], weight: 0 }; group.wallets.push(wallet); group.actions.push(...byWallet.get(wallet)!); group.weight += byWallet.get(wallet)!.reduce((s, a) => s + Math.max(0, a.size * a.price), 0); groups.set(key, group); }
  return [...groups.values()];
}
export function effectiveContributors(clusters: ContributorCluster[], totalWeight: number, capPerWallet: number): ContributorSummary {
  const weights = clusters.map(c => Math.min(Math.max(0, c.weight), Math.max(0, capPerWallet)));
  const total = totalWeight > 0 ? totalWeight : weights.reduce((a, b) => a + b, 0);
  const dominant = weights.length ? Math.max(...weights) : 0;
  return { nEff: nEffective(weights), hhi: computeHHI(weights), clusters, dominantWalletWeight: dominant, capPct: total ? dominant / total : 0 };
}
