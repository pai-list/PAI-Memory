/**
 * PAI-Memory L2 Episodic Chain
 *
 * Spec: docs/PAI-MEM-SPEC.md §3 (L2), §5.1/5.2/5.3/5.5.
 *
 * Model: a chronologically-ordered chain of episodic entries, each carrying a
 * native, non-retro-dated event timestamp (temporal adjacency). NOT bitemporal —
 * light envelope only (D3: createdAt + ttl?). The "chain" is preserved by
 * deterministic chronological order (a sorted index), not by a mutable pointer
 * graph; `nearestBefore` / `slice` give adjacency over time.
 *
 * Decay: power-law `ret(t) = t^(−β)` per §5.1; episodic default β = 1.2, table
 * per content-type. `familyScore` implements §5.2 exactly and deterministically
 * (the clock decides — never an LLM).
 *
 * Budget (D2): soft DEFAULT = 1 MiB, hard ceiling MAX = 10 MiB. On overflow the
 * oldest unpinned entries are released as L2Overflow[] for promotion to L3
 * (§5.3 — never silently truncated). Pinned entries survive soft eviction
 * (right-of-user).
 */

import { MemoryEntry, MemoryTier } from './types';

/** D2: per-layer budget for L2 = 1 MiB soft / 10 MiB hard ceiling. */
export const L2_SOFT_BUDGET_BYTES = 1 * 1024 * 1024;
export const L2_HARD_CEILING_BYTES = 10 * 1024 * 1024;

/**
 * Default power-law exponents per content-type (spec §5.1/§5.2).
 *
 * "Near-zero decay (≳64k h half-life)" for identity-like content is realised
 * as a retention of ≈0.9 over a 90-day window (β ≈ 0.013 at t=2161 h), i.e.
 * it does NOT hit an exponential wall. β is chosen so r(90 d) ≥ 0.9 for the
 * stable types and r(same window) is < 0.1 for the fast `rare` type — the
 * clock decides, deterministically.
 */
export const DECAY_BETA: Record<string, number> = {
  episodic: 1.2, // default for L2
  generic: 1.0,
  rare: 1.5, // β ≈ 1–2 per spec: fast
  identity: 0.013, // near-zero decay (≳64k h half-life)
  commitment: 0.014,
  decision: 0.02,
  user_relevant: 0.04,
  code: 0.2,
};

export interface DecayOptions {
  contentType?: string;
  beta?: number;
}

/** Power-law decay, weighted form of §5.1: r(t) = t^(−β). Hours-based. */
export function powerDecay(ageMs: number, opts: DecayOptions = {}): number {
  const hours = Math.max(0, ageMs) / 3_600_000;
  const beta = opts.contentType ? (DECAY_BETA[opts.contentType] ?? 1.0) : (opts.beta ?? 1.0);
  return Math.pow(hours + 1, -beta);
}

export interface FamilyScoreOptions {
  contentType?: string;
  importance?: number;
  accesses?: number;
  lastAccessMs?: number;
  w1?: number;
  w2?: number;
  w3?: number;
  gamma?: number;
  tauMs?: number;
  now?: number;
}

/**
 * §5.2:
 *   r(t) = w1·importance + w2·(1+accesses)^γ · t^(−β) + w3·0.5^((t−last_access)/τ)
 * Every term stays in [0,1] and the weights default w1=w2=w3 sum to 1.
 * Deterministic and arithmetic-only (a clock, not a judge).
 */
export function familyScore(txnTimeMs: number, opts: FamilyScoreOptions = {}): number {
  const now = opts.now ?? Date.now();
  const ageMs = Math.max(0, now - txnTimeMs);
  const contentType = opts.contentType ?? 'generic';
  const beta = DECAY_BETA[contentType] ?? 1.0;
  const w1 = opts.w1 ?? 0.4;
  const w2 = opts.w2 ?? 0.35;
  const w3 = opts.w3 ?? 0.25;
  const gamma = opts.gamma ?? 0.5;
  const tau = opts.tauMs ?? 24 * 3_600_000; // default: 1 day recency window
  const hours = ageMs / 3_600_000;

  const power = Math.pow(hours + 1, -beta); // t^(−β)
  const accessBoost = Math.pow(1 + (opts.accesses ?? 0), gamma);
  const recency = Math.pow(0.5, (ageMs - Math.max(0, now - (opts.lastAccessMs ?? txnTimeMs))) / tau);

  return clamp01(w1 * (opts.importance ?? 0) + w2 * power * accessBoost + w3 * recency);
}

export interface L2Overflow {
  entry: MemoryEntry;
  reasons: 'budget' | 'hard-cap';
}

export interface L2EpisodicConfig {
  softBudgetBytes?: number; // default 1 MiB
  hardCeilingBytes?: number; // default 10 MiB
  /** Overridable size estimator (tests can inject cheap ones). */
  sizeBytesOf?: (e: MemoryEntry) => number;
}

export class L2EpisodicChain {
  readonly layer = 'L2_WARM' as const;
  readonly tier = MemoryTier.WARM;

  private entries: MemoryEntry[] = [];
  private readonly soft: number;
  private readonly hard: number;
  private readonly sizeOf: (e: MemoryEntry) => number;

  constructor(config: L2EpisodicConfig = {}) {
    this.soft = config.softBudgetBytes ?? L2_SOFT_BUDGET_BYTES;
    this.hard = clamp(config.hardCeilingBytes ?? L2_HARD_CEILING_BYTES, this.soft, L2_HARD_CEILING_BYTES);
    this.sizeOf = config.sizeBytesOf ?? defaultSizeOf;
  }

  // ── Introspection ──

  get sizeBytes(): number {
    return this.entries.reduce((s, e) => s + this.sizeOf(e), 0);
  }

  get count(): number {
    return this.entries.length;
  }

  get headId(): string | null {
    const last = this.entries[this.entries.length - 1];
    return last ? last.id : null;
  }

  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  // ── Reads ──

  get(id: string): MemoryEntry | null {
    const i = this.entries.findIndex((e) => e.id === id);
    return i === -1 ? null : { ...this.entries[i]! };
  }

  /** Chronological slice of the chain within [fromTx, toTx]. */
  slice(fromMs: number, toMs: number): MemoryEntry[] {
    return this.entries
      .filter((e) => {
        const t = e.createdAt;
        return t >= fromMs && t <= toMs;
      })
      .map((e) => ({ ...e }));
  }

  /** Temporal adjacency: newest entry at or before `atMs` (prev-in-chain). */
  nearestBefore(atMs: number): MemoryEntry | null {
    let best: MemoryEntry | null = null;
    for (const e of this.entries) {
      if (e.createdAt <= atMs && (!best || e.createdAt > best.createdAt)) best = e;
    }
    return best ? { ...best } : null;
  }

  // ── Writes ──

  /**
   * Append at the end of the chain. Maintains chronological order; on overflow
   * returns the oldest unpinned entries to promote (never drops data).
   */
  append(entry: MemoryEntry): L2Overflow[] {
    this.entries.push({ ...entry, lastAccessedAt: entry.lastAccessedAt ?? Date.now() });
    this.entries.sort((a, b) => a.createdAt - b.createdAt);
    return this.enforceBudget();
  }

  /** Remove an entry (config/forget). Returns whether removed. */
  forget(id: string): boolean {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    return true;
  }

  /** Promote hole for L7: copy out in chronological order. */
  export(): MemoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private enforceBudget(): L2Overflow[] {
    const overflows: L2Overflow[] = [];
    let over = this.sizeBytes - this.soft;
    if (over <= 0) return overflows;

    // 1) Soft eviction: drop oldest unpinned while freeing; honor hard cap.
    let freed = 0;
    let guard = 0;
    while (this.sizeBytes > this.hard || (over > 0 && freed < 64)) {
      const i = this.entries.findIndex((e) => !this.isPinned(e.id));
      if (i === -1) break; // all pinned — stop; don't cross the user
      const reason: L2Overflow['reasons'] = this.sizeBytes > this.hard ? 'hard-cap' : 'budget';
      const removed = this.entries.splice(i, 1)[0];
      if (!removed) break;
      overflows.push({ entry: removed, reasons: reason });
      freed++;
      guard++;
      over = this.sizeBytes - this.soft;
      if (guard > 100_000) break; // defensive: never spin
    }
    return overflows;
  }

  isPinned(id: string): boolean {
    const e = this.entries.find((x) => x.id === id);
    return !!e && (e.metadata as any)?.custom?.pinned === true;
  }

  choose(contentType: string, now: number): { id: string; txnMs: number; score: number }[] {
    return this.entries
      .map((e) => {
        const score = familyScore(e.createdAt, {
          contentType: contentType ?? (e.metadata as any)?.type,
          importance: (e.metadata as any)?.confidence ?? 0,
          accesses: e.accessCount ?? 0,
          lastAccessMs: e.lastAccessedAt,
          now,
        });
        return { id: e.id, txnMs: e.createdAt, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function defaultSizeOf(e: MemoryEntry): number {
  // content UTF-8 + embedding f32 + envelope overhead.
  let bytes = new TextEncoder().encode(e.content ?? '').byteLength;
  bytes += (e.embedding?.length ?? 0) * 4;
  bytes += 128;
  return bytes;
}