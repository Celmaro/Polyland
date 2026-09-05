/** Typed decisions shared by the production wallet -> quorum -> execution pipeline. */
export type RejectReason =
  | 'invalid_market' | 'no_basket' | 'not_member' | 'unsupported_side'
  | 'stale' | 'thin' | 'cooldown' | 'restart_dedup' | 'risk'
  | 'bankroll' | 'anti_sniper' | 'twap' | 'drift' | 'edge'
  | 'liquidity' | 'min_size' | 'execution_failed' | 'quorum_near_miss'
  | 'quorum_reached' | 'executed';
export interface CandidateDecision {
  id: string;
  wallet: string;
  conditionId: string;
  marketSlug: string;
  tokenId?: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  tradeTimestamp: number;
  discoveredAt: number;
  decidedAt: number;
  ageMs: number;
  domain: string;
  tier: 'PRIMARY' | 'SATELLITE';
  quorumGroup?: string;
  rejectionReason?: RejectReason | string;
  accepted: boolean;
  stage: string;
}
export interface LedgerRecord extends CandidateDecision {
  copyScore?: number;
  reliabilityScore?: number;
  executionScore?: number;
  specializationScore?: number;
  riskScore?: number;
  hhi?: number;
  nEff?: number;
  consensusStrength?: number;
  executableVwap?: number;
  expectedEdge?: number;
  bookSnapshotRef?: string;
}
export type PipelineDecision<T> =
  | { accepted: true; value: T }
  | { accepted: false; reason: RejectReason; detail?: string };
export interface WalletAction {
  wallet: string;
  tier: 'PRIMARY' | 'SATELLITE';
  category: string;
  conditionId: string;
  marketSlug: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
}
export interface ConsensusSignal {
  signalId: string;
  basketName: string;
  side: 'BUY' | 'SELL';
  walletCount: number;
  conditionId: string;
  marketSlug: string;
  outcome: string;
  category: string;
  wallets: string[];
  consensusPrice: number;
  totalSize: number;
  winRate: number;
}
export interface ExecutionDecision {
  signal: ConsensusSignal;
  amountUsd: number;
  price: number;
  dryRun: boolean;
}
