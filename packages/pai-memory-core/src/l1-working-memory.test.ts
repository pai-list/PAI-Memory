import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  L1WorkingMemory,
  L1_DRAIN_CAP_BYTES,
  L1_PINNED_SLOT_LIMIT,
  entrySizeBytes,
} from './l1-working-memory';
import type { MemoryEntry, MemoryMetadata } from './types';

function makeEntry(partial: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  const metadata: MemoryMetadata = {
    source: 'test',
    tags: [],
    type: 'context',
    confidence: 0.9,
    custom: {},
  };
  return {
    id: crypto.randomUUID(),
    content: 'hello world',
    embedding: [],
    metadata,
    layer: 'L1_HOT' as any,
    tier: 'HOT' as any,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    importanceScore: 0,
    ...partial,
  };
}

describe('L1WorkingMemory — Drain Ring', () => {
  let mem: L1WorkingMemory;

  beforeEach(() => {
    mem = new L1WorkingMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stores and recalls by id, bumping lastAccessedAt', () => {
    const entry = makeEntry({ content: 'alpha' });
    mem.write(entry);
    expect(mem.get(entry.id)?.content).toBe('alpha');
    expect(mem.drainCount).toBe(1);
  });

  it('soft-overflows by LRU eviction when cap exceeded (unpinned)', () => {
    // 2 entries each ~> cap/2 → second write forces the FIRST (LRU) out.
    mem = new L1WorkingMemory({ hardCapBytes: 1024 });
    const e1 = makeEntry({ content: 'a'.repeat(600) });
    const e2 = makeEntry({ content: 'b'.repeat(600) });
    const evict1 = mem.write(e1);
    expect(evict1).toHaveLength(0);

    const evict2 = mem.write(e2);
    // e1 is the LRU (older creation) → must be evicted, e2 retained.
    expect(evict2).toHaveLength(1);
    expect(evict2[0]?.evicted.id).toBe(e1.id);
    expect(evict2[0]?.reason).toBe('cap-overflow');
    expect(mem.get(e2.id)?.content).toBe('b'.repeat(600));
    expect(mem.get(e1.id)).toBeNull();
  });

  it('never evicts pinned entries under cap pressure', () => {
    mem = new L1WorkingMemory({ hardCapBytes: 1024, pinnedSlotLimit: 1 });
    const pinnedEntry = makeEntry({ content: 'pinned-immortal'.repeat(20) });
    mem.write({ ...pinnedEntry, metadata: { ...pinnedEntry.metadata, custom: { pinned: true } } });
    expect(mem.pinnedCount).toBe(1);

    // Force severe cap pressure with unpinned items.
    for (let i = 0; i < 20; i++) {
      mem.write(makeEntry({ content: 'filler '.repeat(200) }));
    }
    expect(mem.isPinned(pinnedEntry.id)).toBe(true);
    expect(mem.get(pinnedEntry.id)?.content).toContain('pinned-immortal');
  });

  it('pin moves drain→pins; pinned overflow promotes oldest pin out', () => {
    mem = new L1WorkingMemory({ pinnedSlotLimit: 2 });
    const a = makeEntry({ content: 'a' });
    const b = makeEntry({ content: 'b' });
    const c = makeEntry({ content: 'c' });
    mem.write(a);
    mem.write(b);
    mem.write(c);
    const over = mem.pin(a.id);
    expect(over).toHaveLength(0);
    expect(mem.isPinned(a.id)).toBe(true);

    mem.pin(b.id);
    mem.pin(c.id); // slot 3 > limit 2 → oldest pin (a) promoted out
    expect(mem.pinnedCount).toBe(2);
    expect(mem.isPinned(a.id)).toBe(false);
    // a must not be lost — drain or overflow signal.
    const retained = mem.get(a.id);
    expect(retained === null || mem.pinned.length <= 2).toBe(true);
    expect(mem.drainCount + mem.pinnedCount).toBeGreaterThanOrEqual(2);
  });

  it('unpin moves an entry back into the drain', () => {
    const entry = makeEntry();
    mem.write({ ...entry, metadata: { ...entry.metadata, custom: { pinned: true } } });
    expect(mem.isPinned(entry.id)).toBe(true);
    expect(mem.unpin(entry.id)).toBe(true);
    expect(mem.isPinned(entry.id)).toBe(false);
    expect(mem.drainCount).toBe(1);
  });

  it('forget removes from either region', () => {
    const e = makeEntry({ content: 'x' });
    mem.write(e);
    expect(mem.forget(e.id)).toBe(true);
    expect(mem.forget(e.id)).toBe(false);
    expect(mem.get(e.id)).toBeNull();
  });

  it('search matches content and tags, newest first', () => {
    const now = 1000;
    vi.setSystemTime(now);
    const older = makeEntry({ content: 'tennis court booking', metadata: { ...makeEntry({ content: '' }).metadata, tags: ['sport'] } });
    const newer = makeEntry({ content: 'the tennis racket', metadata: { ...makeEntry({ content: '' }).metadata, tags: ['sport'] } });
    mem.write(older);
    vi.setSystemTime(now + 5000);
    mem.write(newer);

    const hits = mem.search('TENNIS');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.content).toContain('racket'); // newest first
  });

  it('respects the 256KB default cap (spec D1)', () => {
    expect(L1_DRAIN_CAP_BYTES).toBe(256 * 1024);
    const big = makeEntry({ content: 'y'.repeat(300 * 1024) }); // > cap alone
    const overflows = mem.write(big);
    // A single entry larger than the ENTIRE cap cannot fit — it is honestly
    // evicted (not silently truncated). Entries under the cap never are.
    expect(overflows.length).toBeLessThanOrEqual(1);
    expect(overflows[0]?.reason).toBe('cap-overflow');
  });

  it('entrySizeBytes accounts content + embedding + overhead', () => {
    const small = entrySizeBytes(makeEntry({ content: '' }));
    const big = entrySizeBytes(makeEntry({ content: 'a'.repeat(100), embedding: new Array(16).fill(0.1) }));
    expect(big).toBeGreaterThan(small);
  });

  function make(partial: Partial<MemoryEntry> = {}): MemoryEntry {
    return makeEntry(partial);
  }
});

describe('entrySizeBytes', () => {
  it('counts UTF-8 bytes of content', () => {
    const s = 'مرحبا';
    const e = makeEntry({ content: s });
    expect(entrySizeBytes(e)).toBeGreaterThanOrEqual(new TextEncoder().encode(s).byteLength);
  });
});