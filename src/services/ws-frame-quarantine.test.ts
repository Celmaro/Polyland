import { describe, it, expect } from 'vitest';
import { FrameQuarantine } from './ws-frame-quarantine.js';

describe('FrameQuarantine', () => {
  it('records quarantined frames with timestamp and reason, bounded', () => {
    const q = new FrameQuarantine({ maxFrames: 3 });
    q.add('{"bad":', 'parse_error');
    q.add('{"unknown":"event"}', 'unknown_event');
    q.add('{"a":1}', 'schema_error');
    q.add('{"b":2}', 'schema_error'); // evicts the first
    expect(q.count).toBe(3);
    expect(q.frames).toHaveLength(3);
    expect(q.frames[0].reason).toBe('unknown_event'); // oldest kept
    expect(q.frames[1].reason).toBe('schema_error');
    expect(q.frames[2].reason).toBe('schema_error');
    expect(typeof q.frames[0].ts).toBe('number');
    expect(q.frames[0].raw.length).toBeGreaterThan(0);
  });

  it('tracks per-reason counters', () => {
    const q = new FrameQuarantine();
    q.add('a', 'parse_error');
    q.add('b', 'parse_error');
    q.add('c', 'unknown_event');
    expect(q.byReason.parse_error).toBe(2);
    expect(q.byReason.unknown_event).toBe(1);
    expect(q.total).toBe(3);
  });

  it('caps raw frame size to bound memory', () => {
    const q = new FrameQuarantine({ maxFrameBytes: 100 });
    q.add('x'.repeat(5000), 'parse_error');
    expect(q.frames[0].raw.length).toBeLessThanOrEqual(100);
  });

  it('clears on demand (e.g. after operator review)', () => {
    const q = new FrameQuarantine();
    q.add('a', 'parse_error');
    q.clear();
    expect(q.frames).toHaveLength(0);
    expect(q.total).toBe(0);
  });
});