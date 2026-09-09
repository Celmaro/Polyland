export type QuarantineReason = 'parse_error' | 'unknown_event' | 'schema_error';
export interface QuarantinedFrame { raw: string; reason: QuarantineReason; ts: number }
export interface QuarantineOptions { maxFrames?: number; maxFrameBytes?: number }

/** Bounded raw-frame quarantine for WS parse/schema drift investigation. */
export class FrameQuarantine {
  private readonly maxFrames: number;
  private readonly maxFrameBytes: number;
  private _frames: QuarantinedFrame[] = [];
  private _byReason: Record<string, number> = {};
  constructor(options: QuarantineOptions = {}) { this.maxFrames = options.maxFrames ?? 100; this.maxFrameBytes = options.maxFrameBytes ?? 16_384; }
  add(raw: string, reason: QuarantineReason): void { this._frames.push({ raw: raw.slice(0, this.maxFrameBytes), reason, ts: Date.now() }); if (this._frames.length > this.maxFrames) this._frames.splice(0, this._frames.length - this.maxFrames); this._byReason[reason] = (this._byReason[reason] ?? 0) + 1; }
  get frames(): readonly QuarantinedFrame[] { return [...this._frames]; }
  get byReason(): Readonly<Record<string, number>> { return { ...this._byReason }; }
  get count(): number { return this._frames.length; }
  get total(): number { return Object.values(this._byReason).reduce((a,b)=>a+b,0); }
  clear(): void { this._frames = []; this._byReason = {}; }
}