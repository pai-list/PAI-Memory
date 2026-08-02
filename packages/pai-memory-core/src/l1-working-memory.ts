/**
 * PAI-Memory L1 Working Memory — "Drain Ring"
 *
 * Spec: docs/PAI-MEM-SPEC.md §3 (L1), §5.3, Ratification D1.
 *
 * Design (D1, ratified 2026-08-02):
 *   - drainRing:   auto-managed working set, LRU eviction, ≤ hardCap bytes.
 *   - pinnedSlots: explicit user/agent pins, up to PIN_SLOT_LIMIT (8).
 *                    NEVER silently evicted — right-of-user wins.
 *   - soft overflow: writing past the cap evicts LRU (unpinned); overflowing
 *     the pin slots promotes the OLDEST pin out (hand back to the caller to
 *     persist into L2), it does not drop data.
 *
 * Every mutation bumps `lastAccessedAt` and callers should refresh `accessCount`.
 */

import { MemoryEntry, MemoryLayer, MemoryTier } from './types';

export const L1_DRAIN_CAP_BYTES = 256 * 1024; // 256KB
export const L1_PINNED_SLOT_LIMIT = 8;
export const L1_DEFAULT_SIZE_EST = 512; // heuristic bytes per entry when unknown

/** Bytes estimate for an entry — used for the soft cap accounting. */
export function entrySizeBytes(e: Pick<MemoryEntry, 'content' | 'embedding'>): number {
  // content: UTF-8 bytes; embedding: f32 (4 bytes/dim) + sparse metadata overhead.
  return new TextEncoder().encode(e.content).byteLength + (e.embedding?.length ?? 0) * 4 + 64;
}

export interface L1WorkingMemoryConfig {
  hardCapBytes?: number;      // default 256KB
  pinnedSlotLimit?: number;   // default 8
}

/** Result of a write that forced an overflow promotion out of L1. */
export interface L1Overflow {
  /** The entry that had to leave L1 — persist into L2. */
  evicted: MemoryEntry;
  reason: 'cap-overflow' | 'pinned-overflow';
}

export class L1WorkingMemory {
  readonly layer = MemoryLayer.L1_HOT;
  readonly tier = MemoryTier.HOT;

  private drain: MemoryEntry[] = [];
  private pinned: MemoryEntry[] = [];
  private readonly hardCap: number;
  private readonly pinLimit: number;

  constructor(config: L1WorkingMemoryConfig = {}) {
    this.hardCap = config.hardCapBytes ?? L1_DRAIN_CAP_BYTES;
    this.pinLimit = config.pinnedSlotLimit ?? L1_PINNED_SLOT_LIMIT;
  }

  // ── Introspection ──

  get sizeBytes(): number {
    return [...this.drain, ...this.pinned].reduce((s, e) => s + entrySizeBytes(e), 0);
  }

  get drainCount(): number {
    return this.drain.length;
  }

  get pinnedCount(): number {
    return this.pinned.length;
  }

  /** All entry ids currently resident (drain first, pins last). */
  ids(): string[] {
    return [...this.drain, ...this.pinned].map((e) => e.id);
  }

  // ── Read ──

  get(id: string): MemoryEntry | null {
    const hit = this.drain.find((e) => e.id === id) ?? this.pinned.find((e) => e.id === id) ?? null;
    if (hit) {
      hit.lastAccessedAt = Date.now();
    }
    return hit ? { ...hit } : null;
  }

  isPinned(id: string): boolean {
    return this.pinned.some((e) => e.id === id);
  }

  // ── Write ──

  /**
   * Write an entry into L1. If it would exceed the drain cap, LRU-evict from
   * the drain (never from pins). Returns overflow entries that the caller must
   * promote to L2.
   */
  write(entry: MemoryEntry): L1Overflow[] {
    const copy: MemoryEntry = { ...entry, lastAccessedAt: Date.now() };
    const overflows: L1Overflow[] = [];

    if (entry.metadata?.custom?.pinned === true || this.pinned.some((e) => e.id === entry.id)) {
      this.writePinned(copy, overflows);
    } else {
      this.writeDrain(copy, overflows);
    }

    return overflows;
  }

  private writeDrain(copy: MemoryEntry, overflows: L1Overflow[]): void {
    const existingIdx = this.drain.findIndex((e) => e.id === copy.id);
    if (existingIdx !== -1) {
      // In-place update (keeps LRU position), never evicts itself.
      this.drain[existingIdx] = copy;
      return;
    }
    this.drain.push(copy);

    // Enforce cap by LRU eviction of the drain only.
    while (this.sizeBytes > this.hardCap && this.drain.length > 0) {
      // Drain entries are ordered oldest-accessed first → pop(0) is the LRU.
      const lru = this.drain.shift();
      if (lru) overflows.push({ evicted: lru, reason: 'cap-overflow' });
    }
  }

  private writePinned(copy: MemoryEntry, overflows: L1Overflow[]): void {
    const idx = this.pinned.findIndex((e) => e.id === copy.id);
    if (idx !== -1) {
      this.pinned[idx] = copy;
      return;
    }
    this.pinned.push(copy);

    // Pinned full → the oldest pin moves out (promote to L2), newest stays.
    while (this.pinned.length > this.pinLimit) {
      const oldest = this.pinned.shift();
      if (oldest) overflows.push({ evicted: oldest, reason: 'pinned-overflow' });
    }
  }

  /** Pin an existing drain entry (moves it up and out of LRU eviction). */
  pin(id: string): L1Overflow[] {
    const idx = this.drain.findIndex((e) => e.id === id);
    if (idx === -1) return this.isPinned(id) ? [] : [];
    const [entry] = this.drain.splice(idx, 1);
    if (!entry) return [];
    const overflows: L1Overflow[] = [];
    this.writePinned(entry, overflows);
    return overflows;
  }

  /** Unpin → moves back into the drain (observable LRU semantics). */
  unpin(id: string): boolean {
    const idx = this.pinned.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [entry] = this.pinned.splice(idx, 1);
    if (entry) this.drain.push(entry);
    return true;
  }

  /** Explicit forget: remove from either region. Returns whether removed. */
  forget(id: string): boolean {
    const d = this.drain.findIndex((e) => e.id === id);
    if (d !== -1) {
      this.drain.splice(d, 1);
      return true;
    }
    const p = this.pinned.findIndex((e) => e.id === id);
    if (p !== -1) {
      this.pinned.splice(p, 1);
      return true;
    }
    return false;
  }

  // ── Search (fast, no embedding required) ──

  /** Case-insensitive substring search across content+tags; newest-first. */
  search(query: string, limit = 5): MemoryEntry[] {
    const q = query.toLowerCase();
    const hits = [...this.drain, ...this.pinned]
      .filter(
        (e) =>
          e.content.toLowerCase().includes(q) ||
          e.metadata.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    return hits.slice(0, limit).map((e) => ({ ...e }));
  }

  /** Snapshot for persistence/promotion. */
  export(): { drain: MemoryEntry[]; pinned: MemoryEntry[]; sizeBytes: number } {
    return {
      drain: this.drain.map((e) => ({ ...e })),
      pinned: this.pinned.map((e) => ({ ...e })),
      sizeBytes: this.sizeBytes,
    };
  }
}