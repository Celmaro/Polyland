/**
 * Durable, namespaced runtime state for Polyland.
 * Uses one atomic JSON document temporarily; this is deliberately behind an
 * interface so the storage can move to SQLite without changing strategy code.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PolylandState {
  version: 1;
  updatedAt: number;
  walletUniverse?: unknown;
  quorum?: unknown;
  risk?: unknown;
  positions?: unknown;
  screening?: unknown;
  audit?: unknown;
}

export interface StateStore {
  load(): Promise<PolylandState | null>;
  save(patch: Partial<Omit<PolylandState, 'version' | 'updatedAt'>>): Promise<void>;
}

export class JsonStateStore implements StateStore {
  private current: PolylandState = { version: 1, updatedAt: Date.now() };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<PolylandState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as PolylandState;
      if (parsed.version !== 1) return null;
      this.current = { ...this.current, ...parsed };
      return this.current;
    } catch {
      return null;
    }
  }

  async save(patch: Partial<Omit<PolylandState, 'version' | 'updatedAt'>>): Promise<void> {
    this.current = { ...this.current, ...patch, updatedAt: Date.now() };
    const snapshot = JSON.stringify(this.current);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
