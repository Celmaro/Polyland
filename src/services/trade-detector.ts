/**
 * TradeDetector — replacement detection layer for Polyland.
 *
 * The design replaces the "activity feed is truth" assumption with a
 * fast-path + reconciliation model:
 *
 *   fast hint (Activity WS)  ->  detect(candidate)  ->  DETECTED (provisional)
 *   authoritative source     ->  reconcile(...)     ->  CONFIRMED  /  REJECTED_IDENTITY
 *
 * Identity keys are canonical and durable: we always store the canonical
 * identity, never the displayed tx hash string, and we claim the key BEFORE
 * any downstream consumer may act on it. This prevents replay, reconnect,
 * and double-polling from executing the same leader intent twice.
 *
 * This module is intentionally pure of SDK dependencies. It persists nothing
 * itself; the runtime provides a `ledger` with `claim(key, value)`, and
 * `reconcile()` drives the copy planner.
 */
export type TradeSide = 'BUY' | 'SELL';

/** Raw candidate from the fast hint path (Activity WS). */
export interface CandidateTrade {
  rawId?: string;
  wallet: string;
  conditionId: string;
  marketSlug?: string;
  tokenId?: string;
  outcome?: string;
  side: TradeSide;
  size: number;
  price: number;
  timestamp: number;
  /** If absent, identity is provisional until reconciliation. */
  sourceRef?: string;
}

export type RejectReason =
  | 'duplicate'
  | 'stale'
  | 'identity_mismatch'
  | 'invalid_market'
  | 'unresolved'
  | 'dust'
  | 'unsupported'
  | 'reconciliation_timeout';

export type DetectionStatus =
  | 'DETECTED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'RECONCILED'
  | 'EXPIRED';

export interface DetectionRecord {
  key: string;
  wallet: string;
  conditionId: string;
  marketSlug?: string;
  tokenId?: string;
  outcome?: string;
  side: TradeSide;
  size: number;
  price: number;
  timestamp: number;
  sourceRef?: string;
  status: DetectionStatus;
  rejectReason?: RejectReason;
  detectedAt: number;
  reconciledAt?: number;
  aggregated?: boolean;
}

export interface TradeDetectorConfig {
  staleMs?: number;
  minNotional?: number;
  aggregationWindowMs?: number;
  allowProvisional?: boolean;
}

export interface TradeLedger {
  /** Returns true if `key` was not yet present and now claimed. */
  claim(key: string, value: unknown): boolean;
  get(key: string): unknown;
}

export interface AggregatedTrade {
  key: string;
  wallet: string;
  conditionId: string;
  marketSlug?: string;
  tokenId?: string;
  outcome?: string;
  side: TradeSide;
  /** Net signed quantity. */
  totalSize: number;
  /** Volume-weighted average price. */
  vwap: number;
  fillCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  prices: number[];
}

const DEFAULT_STALE_MS = 2 * 60 * 1000;
const DEFAULT_MIN_NOTIONAL = 1.0;
const DEFAULT_AGGREGATION_WINDOW_MS = 5000;

/**
 * Canonical identity key for a leader fill. Uses the deepest available
 * identity: sourceRef (tx hash) when present, otherwise a deterministic
 * wallet+market+side+timestamp bucket key. Never trusts display hash only.
 */
export function identityKey(c: CandidateTrade, bucketMs = 1000): string {
  const wallet = c.wallet.toLowerCase();
  const cond = c.conditionId.toLowerCase();
  const side = c.side.toLowerCase();
  if (c.sourceRef && c.sourceRef !== '') {
    // Use sourceRef if it looks like a real identifier (>= 8 chars).
    const s = c.sourceRef.trim();
    if (s.length >= 8) return `tx:${s}`;
  }
  const bucket = Math.floor(c.timestamp / bucketMs) * bucketMs;
  return `wallet:${wallet}:${cond}:${side}:${bucket}`;
}

export class TradeDetector {
  private readonly seen = new Map<string, DetectionRecord>();
  private readonly staleMs: number;
  private readonly minNotional: number;
  private readonly aggregationWindowMs: number;
  private readonly allowProvisional: boolean;

  constructor(
    private readonly ledger: TradeLedger,
    private readonly config: TradeDetectorConfig = {},
  ) {
    this.staleMs = config.staleMs ?? DEFAULT_STALE_MS;
    this.minNotional = config.minNotional ?? DEFAULT_MIN_NOTIONAL;
    this.aggregationWindowMs = config.aggregationWindowMs ?? DEFAULT_AGGREGATION_WINDOW_MS;
    this.allowProvisional = config.allowProvisional ?? false;
  }

  /** Canonical key (public for tests). */
  keyFor(c: CandidateTrade): string {
    return identityKey(c);
  }

  /**
   * Process a fast-hint candidate. Returns DETECTED (provisional or
   * auto-confirmed), REJECTED, or null if the ledger already claimed it.
   */
  detect(c: CandidateTrade, now = Date.now()): DetectionRecord | null {
    const key = this.keyFor(c);
    const existing = this.ledger.get(key);
    if (existing !== undefined && existing !== null) {
      // Already claimed — never re-announce the same leader intent.
      return null;
    }
    if (!c.wallet || !c.conditionId || !c.side) return this.reject(c, key, 'invalid_market', now);
    if (!Number.isFinite(c.timestamp)) return this.reject(c, key, 'invalid_market', now);
    if (!Number.isFinite(c.size) || c.size <= 0 || !Number.isFinite(c.price) || c.price <= 0) {
      return this.reject(c, key, 'invalid_market', now);
    }
    const notional = c.size * c.price;
    if (notional < this.minNotional) return this.reject(c, key, 'dust', now);
    if (now - c.timestamp > this.staleMs) return this.reject(c, key, 'stale', now);

    const claimed = this.ledger.claim(key, { detectedAt: now });
    if (!claimed) return null;

    const rec: DetectionRecord = {
      key,
      wallet: c.wallet.toLowerCase(),
      conditionId: c.conditionId,
      marketSlug: c.marketSlug,
      tokenId: c.tokenId,
      outcome: c.outcome,
      side: c.side,
      size: c.size,
      price: c.price,
      timestamp: c.timestamp,
      sourceRef: c.sourceRef,
      status: this.allowProvisional ? 'DETECTED' : 'CONFIRMED',
      detectedAt: now,
    };
    this.seen.set(key, rec);
    return rec;
  }

  /**
   * Reconcile a candidate against the authoritative wallet record. When the
   * authoritative values disagree, the identity is rejected, not copied.
   */
  reconcile(
    c: CandidateTrade,
    authoritative: { size?: number; price?: number; wallet?: string; side?: TradeSide },
    now = Date.now(),
  ): DetectionRecord {
    const key = this.keyFor(c);
    const rec = this.seen.get(key) ?? this.ledger.get(key) as DetectionRecord;
    if (authoritative.wallet && authoritative.wallet.toLowerCase() !== c.wallet.toLowerCase()) {
      const rejected = { ...(rec ?? this.toRecord(c, key, now)), status: 'REJECTED' as DetectionStatus, rejectReason: 'identity_mismatch' as RejectReason, reconciledAt: now };
      this.seen.set(key, rejected);
      return rejected;
    }
    // Values are allowed to differ only within a tolerance; size/price mismatch
    // beyond tolerance is an identity problem, because a different fill is a
    // different trade.
    const tol = 0.05;
    const sizeOk = authoritative.size === undefined || Math.abs(authoritative.size - c.size) / Math.max(c.size, 1e-9) <= tol;
    const priceOk = authoritative.price === undefined || Math.abs(authoritative.price - c.price) / Math.max(c.price, 1e-9) <= tol;
    const sideOk = !authoritative.side || authoritative.side === c.side;
    if (!sizeOk || !priceOk || !sideOk) {
      const rejected = { ...(rec ?? this.toRecord(c, key, now)), status: 'REJECTED' as DetectionStatus, rejectReason: 'identity_mismatch' as RejectReason, reconciledAt: now };
      this.seen.set(key, rejected);
      return rejected;
    }
    const confirmed: DetectionRecord = { ...(rec ?? this.toRecord(c, key, now)), status: 'CONFIRMED', reconciledAt: now };
    this.seen.set(key, confirmed);
    return confirmed;
  }

  /**
   * Aggregate confirmed fills for the same wallet/market/side within the
   * aggregation window. Raw fills stay immutable for audit.
   */
  aggregate(key: string, now = Date.now()): AggregatedTrade | null {
    const rec = this.seen.get(key);
    if (!rec) return null;
    const windowRecs = [...this.seen.values()].filter(
      (r) =>
        r.wallet === rec.wallet &&
        r.conditionId === rec.conditionId &&
        r.side === rec.side &&
        r.status === 'CONFIRMED' &&
        Math.abs(r.timestamp - rec.timestamp) <= this.aggregationWindowMs,
    );
    if (windowRecs.length === 0) return null;
    // A "parent" decision should span the first and last observed fill in the
    // window. Volume-weighted average price across fills.
    let totalSize = 0;
    let notional = 0;
    let prices: number[] = [];
    let firstTimestamp = Infinity;
    let lastTimestamp = -Infinity;
    for (const r of windowRecs) {
      totalSize += r.side === 'SELL' ? -Math.abs(r.size) : Math.abs(r.size);
      notional += r.size * r.price;
      prices.push(r.price);
      firstTimestamp = Math.min(firstTimestamp, r.timestamp);
      lastTimestamp = Math.max(lastTimestamp, r.timestamp);
    }
    return {
      key: rec.key,
      wallet: rec.wallet,
      conditionId: rec.conditionId,
      marketSlug: rec.marketSlug,
      tokenId: rec.tokenId,
      outcome: rec.outcome,
      side: rec.side,
      totalSize,
      vwap: totalSize !== 0 ? notional / Math.abs(totalSize) : 0,
      fillCount: windowRecs.length,
      firstTimestamp,
      lastTimestamp,
      prices,
    };
  }

  private reject(c: CandidateTrade, key: string, reason: RejectReason, now: number): DetectionRecord {
    const rec = this.toRecord(c, key, now);
    rec.status = 'REJECTED';
    rec.rejectReason = reason;
    // Rejected keys are remembered so we never re-process them, but a stale
    // or dust rejection can be superseded by a later valid one in the same
    // bucket (the ledger key differs because bucket includes timestamp).
    this.seen.set(key, rec);
    return rec;
  }

  private toRecord(c: CandidateTrade, key: string, now: number): DetectionRecord {
    return {
      key,
      wallet: c.wallet.toLowerCase(),
      conditionId: c.conditionId,
      marketSlug: c.marketSlug,
      tokenId: c.tokenId,
      outcome: c.outcome,
      side: c.side,
      size: c.size,
      price: c.price,
      timestamp: c.timestamp,
      sourceRef: c.sourceRef,
      status: 'DETECTED',
      detectedAt: now,
    };
  }
}