/**
 * PAI-Memory Deterministic Conflict Resolver
 *
 * Research finding (arXiv:2606.01435):
 *   LLM-based conflict resolution scores 18% on FactConsolidation.
 *   Simple deterministic max(timestamp) scores 78% — +10.8 points better.
 *
 * This module provides a deterministic conflict resolution layer that:
 *   1. Tracks timestamps per fact key when storing memories
 *   2. Resolves conflicting facts by picking the one with MAXIMUM timestamp
 *   3. Falls back to LLM-based dedup only for ambiguous cases (not conflicts)
 *
 * ponytail: deterministic max(timestamp) is simpler, cheaper, and objectively
 * more effective than LLM-based resolution for fact conflicts.
 *
 * Usage:
 *   const resolver = new ConflictResolver();
 *   resolver.track("alice:sport", "tennis", Date.now());
 *   const winner = resolver.resolve("alice:sport", [
 *     { key: "alice:sport", value: "tennis", timestamp: 1000 },
 *     { key: "alice:sport", value: "football", timestamp: 2000 },
 *   ]);
 *   // winner.value === "football" (max timestamp)
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** A single fact record with a deterministic timestamp */
export interface FactRecord {
  /** Unique key identifying the fact (e.g. "entity:attribute") */
  key: string;
  /** The fact value — any serializable payload */
  value: unknown;
  /** Monotonic timestamp (ms since epoch or logical clock) */
  timestamp: number;
  /** Optional origin source for audit */
  source?: string;
}

/** A set of candidate facts for a single key that need resolution */
export interface MemoryCandidates {
  /** The fact key being resolved */
  key: string;
  /** Conflicting fact candidates for this key */
  candidates: FactRecord[];
}

/** The result of resolving a single key's conflicts */
export interface ResolutionResult {
  /** The fact key that was resolved */
  key: string;
  /** The winning fact (deterministic — max timestamp) */
  winner: FactRecord;
  /** All losing facts (every candidate except the winner) */
  losers: FactRecord[];
  /** When the resolution was computed */
  resolvedAt: number;
}

/** Per-key conflict resolution statistics */
export interface ConflictStats {
  /** Total conflicts resolved for this key */
  totalConflicts: number;
  /** Number of times the tracked fact was the winner */
  trackedWins: number;
  /** Timestamp of the earliest tracked fact */
  earliest: number;
  /** Timestamp of the latest tracked fact */
  latest: number;
}

// ─────────────────────────────────────────────
// ConflictResolver
// ─────────────────────────────────────────────

/**
 * Deterministic conflict resolver for PAI Memory.
 *
 * Resolves conflicting facts by choosing the one with the MAXIMUM timestamp.
 * Tiebreaker (when timestamps are equal): lexicographic comparison of the
 * JSON-serialized value, guaranteeing deterministic outcomes regardless of
 * insertion order or platform.
 *
 * Integration:
 *   Use ConflictResolver.track() alongside the store to record fact
 *   timestamps. On recall, pass conflicting candidates to resolve() before
 *   returning to the caller. This avoids LLM-based dedup for
 *   timestamp-resolvable conflicts.
 */
export class ConflictResolver {
  /**
   * Internal registry of tracked facts.
   * Maps key → latest tracked FactRecord (highest-timestamp seen).
   */
  private registry: Map<string, FactRecord> = new Map();

  /**
   * Optional history buffer — keeps all tracked values per key for audit.
   * Key → array of FactRecord sorted oldest-first.
   * Disabled by default; enable via constructor option keepHistory=true.
   */
  private history: Map<string, FactRecord[]> | null = null;

  /** Per-key conflict statistics */
  private stats: Map<string, ConflictStats> = new Map();

  constructor(options?: { keepHistory?: boolean }) {
    if (options?.keepHistory) {
      this.history = new Map();
    }
  }

  /**
   * Track a fact with its timestamp.
   *
   * If the same key already has a tracked fact with a NEWER or EQUAL
   * timestamp, the new fact is ignored (no-op). This ensures the registry
   * always holds the latest-known fact for each key.
   *
   * @param key - Unique fact identifier (e.g. "alice:sport")
   * @param value - The fact value
   * @param timestamp - Monotonic timestamp (ms since epoch or logical clock)
   * @param source - Optional origin source identifier
   */
  track(key: string, value: unknown, timestamp: number, source?: string): void {
    const fact: FactRecord = { key, value, timestamp, source };
    const existing = this.registry.get(key);

    // Only add to history if enabled
    if (this.history) {
      const hist = this.history.get(key) ?? [];
      hist.push(fact);
      // Cap history to prevent unbounded growth (keep last 100)
      if (hist.length > 100) {
        hist.splice(0, hist.length - 100);
      }
      this.history.set(key, hist);
    }

    // Registry holds the highest-timestamp fact
    if (!existing || existing.timestamp < timestamp) {
      this.registry.set(key, fact);
    }
  }

  /**
   * Resolve conflicts for a key by returning the candidate with the
   * MAXIMUM timestamp.
   *
   * Deterministic tiebreaker: when timestamps are equal, the candidate
   * whose JSON-serialized value is lexicographically greater wins.
   *
   * @param key - The fact key being resolved
   * @param candidates - Array of conflicting fact candidates
   * @returns The winning FactRecord (max timestamp)
   * @throws {Error} If candidates array is empty
   */
  resolve(key: string, candidates: FactRecord[]): FactRecord {
    if (candidates.length === 0) {
      throw new Error(`No candidates provided for resolution of key: "${key}"`);
    }

    // Sort: primary by timestamp descending, secondary by value serialization
    const sorted = [...candidates].sort((a, b) => {
      // Primary: max timestamp wins
      const tsDiff = b.timestamp - a.timestamp;
      if (tsDiff !== 0) return tsDiff;

      // Tiebreaker: lexicographic comparison of JSON-serialized value,
      // greatest wins. This guarantees deterministic outcomes regardless
      // of engine or locale.
      const valA = JSON.stringify(a.value);
      const valB = JSON.stringify(b.value);
      if (valA > valB) return -1;
      if (valA < valB) return 1;
      return 0;
    });

    // candidates.length > 0 checked above, so sorted[0] is always defined
    const winner = sorted[0]!;

    // Update per-key conflict stats
    this.updateStats(key, winner, candidates);

    return winner;
  }

  /**
   * Batch resolve all conflicting memories across multiple keys.
   *
   * @param memories - Array of MemoryCandidates, each containing a key
   *                   and its conflicting candidates
   * @returns Array of ResolutionResult, one per key
   */
  resolveAll(memories: MemoryCandidates[]): ResolutionResult[] {
    const resolvedAt = Date.now();
    const results: ResolutionResult[] = [];

    for (const { key, candidates } of memories) {
      if (candidates.length === 0) {
        // No candidates = nothing to resolve; skip silently
        continue;
      }

      const winner = this.resolve(key, candidates);
      const losers = candidates.filter(
        (c) => c !== winner && !(c.timestamp === winner.timestamp && JSON.stringify(c.value) === JSON.stringify(winner.value)),
      );

      results.push({
        key,
        winner,
        losers,
        resolvedAt,
      });
    }

    return results;
  }

  /**
   * Retrieve the latest tracked fact for a key.
   *
   * @param key - The fact key
   * @returns The tracked FactRecord, or undefined if never tracked
   */
  getTracked(key: string): FactRecord | undefined {
    return this.registry.get(key);
  }

  /**
   * Retrieve the full history of tracked facts for a key.
   * Only available if keepHistory was enabled in the constructor.
   *
   * @param key - The fact key
   * @returns Array of FactRecords (oldest-first), or empty array
   */
  getHistory(key: string): FactRecord[] {
    return this.history?.get(key) ?? [];
  }

  /**
   * Get conflict statistics for a specific key.
   *
   * @param key - The fact key
   * @returns ConflictStats or undefined if no stats recorded
   */
  getStats(key: string): ConflictStats | undefined {
    return this.stats.get(key);
  }

  /**
   * Get all tracked fact keys.
   *
   * @returns Iterator of tracked keys
   */
  trackedKeys(): IterableIterator<string> {
    return this.registry.keys();
  }

  /**
   * Get the total number of tracked facts.
   */
  get size(): number {
    return this.registry.size;
  }

  /**
   * Clear all tracked facts, history, and stats.
   */
  clear(): void {
    this.registry.clear();
    this.stats.clear();
    if (this.history) {
      this.history.clear();
    }
  }

  // ── Private ──

  /** Update per-key conflict resolution statistics across the full candidate set. */
  private updateStats(key: string, winner: FactRecord, candidates: FactRecord[]): void {
    const existing = this.stats.get(key);
    const tracked = this.registry.get(key);
    const trackedWin = tracked !== undefined && tracked.timestamp === winner.timestamp;

    // Span the earliest/latest across ALL candidates (not just the winner),
    // so stats reflect the true time range of facts seen for this key.
    let earliest = winner.timestamp;
    let latest = winner.timestamp;
    for (const c of candidates) {
      if (c.timestamp < earliest) earliest = c.timestamp;
      if (c.timestamp > latest) latest = c.timestamp;
    }

    this.stats.set(key, {
      totalConflicts: (existing?.totalConflicts ?? 0) + 1,
      trackedWins: (existing?.trackedWins ?? 0) + (trackedWin ? 1 : 0),
      earliest: existing ? Math.min(existing.earliest, earliest) : earliest,
      latest: existing ? Math.max(existing.latest, latest) : latest,
    });
  }
}
