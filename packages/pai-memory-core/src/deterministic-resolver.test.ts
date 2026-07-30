/**
 * Tests for PAI-Memory Deterministic Conflict Resolver
 *
 * Research anchor (arXiv:2606.01435):
 *   Deterministic max(timestamp) scores 78% on FactConsolidation vs
 *   LLM-based resolution at 18%. These tests verify the resolver's
 *   correctness, determinism, and integration contract.
 */

import { describe, it, expect } from "vitest";
import {
  ConflictResolver,
  type FactRecord,
  type MemoryCandidates,
} from "./deterministic-resolver";

// ─────────────────────────────────────────────
// track()
// ─────────────────────────────────────────────

describe("ConflictResolver.track()", () => {
  it("stores a fact with timestamp", () => {
    const r = new ConflictResolver();
    r.track("alice:sport", "tennis", 1000);
    expect(r.getTracked("alice:sport")).toEqual({
      key: "alice:sport",
      value: "tennis",
      timestamp: 1000,
      source: undefined,
    });
  });

  it("overwrites when newer timestamp arrives", () => {
    const r = new ConflictResolver();
    r.track("alice:sport", "tennis", 1000);
    r.track("alice:sport", "football", 2000);
    expect(r.getTracked("alice:sport")?.value).toBe("football");
    expect(r.getTracked("alice:sport")?.timestamp).toBe(2000);
  });

  it("ignores older timestamp (does not downgrade)", () => {
    const r = new ConflictResolver();
    r.track("alice:sport", "football", 2000);
    r.track("alice:sport", "tennis", 1000); // older — should be ignored
    expect(r.getTracked("alice:sport")?.value).toBe("football");
    expect(r.getTracked("alice:sport")?.timestamp).toBe(2000);
  });

  it("ignores equal timestamp (no-op on tie)", () => {
    const r = new ConflictResolver();
    r.track("alice:sport", "football", 2000);
    r.track("alice:sport", "tennis", 2000); // same ts — should be ignored
    expect(r.getTracked("alice:sport")?.value).toBe("football");
  });

  it("tracks source when provided", () => {
    const r = new ConflictResolver();
    r.track("bob:city", "New York", 3000, "zep-report");
    expect(r.getTracked("bob:city")?.source).toBe("zep-report");
  });

  it("handles multiple independent keys", () => {
    const r = new ConflictResolver();
    r.track("a", 1, 100);
    r.track("b", 2, 200);
    r.track("c", 3, 300);
    expect(r.size).toBe(3);
    expect(r.getTracked("a")?.value).toBe(1);
    expect(r.getTracked("b")?.value).toBe(2);
    expect(r.getTracked("c")?.value).toBe(3);
  });

  it("stores complex object values", () => {
    const r = new ConflictResolver();
    const obj = { name: "Ali", scores: [95, 88] };
    r.track("student:ali", obj, 5000);
    expect(r.getTracked("student:ali")?.value).toEqual(obj);
  });
});

// ─────────────────────────────────────────────
// history (when keepHistory is enabled)
// ─────────────────────────────────────────────

describe("ConflictResolver history", () => {
  it("does not keep history by default", () => {
    const r = new ConflictResolver();
    r.track("x", 1, 100);
    r.track("x", 2, 200);
    expect(r.getHistory("x")).toEqual([]);
  });

  it("keeps history when option enabled", () => {
    const r = new ConflictResolver({ keepHistory: true });
    r.track("x", 1, 100);
    r.track("x", 2, 200);
    r.track("x", 3, 300);
    const hist = r.getHistory("x");
    expect(hist).toHaveLength(3);
    expect(hist[0]?.value).toBe(1);
    expect(hist[1]?.value).toBe(2);
    expect(hist[2]?.value).toBe(3);
  });

  it("caps history at 100 entries to prevent unbounded growth", () => {
    const r = new ConflictResolver({ keepHistory: true });
    for (let i = 0; i < 150; i++) {
      r.track("growing", i, i);
    }
    const hist = r.getHistory("growing");
    expect(hist).toHaveLength(100);
    // The oldest 50 should have been dropped
    expect(hist[0]?.value).toBe(50);
    expect(hist[99]?.value).toBe(149);
  });
});

// ─────────────────────────────────────────────
// resolve()
// ─────────────────────────────────────────────

describe("ConflictResolver.resolve()", () => {
  it("returns the candidate with maximum timestamp", () => {
    const r = new ConflictResolver();
    const candidates: FactRecord[] = [
      { key: "weather", value: "sunny", timestamp: 100 },
      { key: "weather", value: "rainy", timestamp: 300 },
      { key: "weather", value: "cloudy", timestamp: 200 },
    ];
    const winner = r.resolve("weather", candidates);
    expect(winner.value).toBe("rainy");
    expect(winner.timestamp).toBe(300);
  });

  it("throws on empty candidates", () => {
    const r = new ConflictResolver();
    expect(() => r.resolve("anything", [])).toThrow(
      'No candidates provided for resolution of key: "anything"',
    );
  });

  it("resolves single candidate trivially", () => {
    const r = new ConflictResolver();
    const winner = r.resolve("lonely", [{ key: "lonely", value: "only", timestamp: 42 }]);
    expect(winner.value).toBe("only");
  });

  it("uses deterministic tiebreaker when timestamps are equal", () => {
    const r = new ConflictResolver();
    // Two candidates, same timestamp — winner should be deterministic
    const candidates: FactRecord[] = [
      { key: "tie", value: "alpha", timestamp: 1000 },
      { key: "tie", value: "beta", timestamp: 1000 },
    ];
    const winner1 = r.resolve("tie", candidates);
    const winner2 = r.resolve("tie", candidates);
    // Deterministic: same input always produces same output
    expect(winner1.value).toBe(winner2.value);
    // Lexicographically: "beta" > "alpha" → "beta" should win
    expect(winner1.value).toBe("beta");
  });

  it("tiebreaker: lexicographic comparison of serialized values", () => {
    const r = new ConflictResolver();
    // Same timestamp, JSON.stringify comparison decides
    const candidates: FactRecord[] = [
      { key: "tie2", value: { z: 1 }, timestamp: 500 },
      { key: "tie2", value: { a: 2 }, timestamp: 500 },
    ];
    // JSON.stringify({z:1}) = '{"z":1}', JSON.stringify({a:2}) = '{"a":2}'
    // '{"a":2}' < '{"z":1}' lexicographically → {a:2} wins
    const winner = r.resolve("tie2", candidates);
    expect(winner.value).toEqual({ a: 2 });
  });

  it("deterministic across multiple calls with same candidates", () => {
    const r = new ConflictResolver();
    const candidates: FactRecord[] = [
      { key: "stable", value: "first", timestamp: 500 },
      { key: "stable", value: "second", timestamp: 1000 },
      { key: "stable", value: "third", timestamp: 750 },
    ];
    // Run resolve many times — always same result
    for (let i = 0; i < 100; i++) {
      const winner = r.resolve("stable", [...candidates]);
      expect(winner.value).toBe("second");
      expect(winner.timestamp).toBe(1000);
    }
  });
});

// ─────────────────────────────────────────────
// resolveAll()
// ─────────────────────────────────────────────

describe("ConflictResolver.resolveAll()", () => {
  it("resolves multiple keys in batch", () => {
    const r = new ConflictResolver();
    const memories: MemoryCandidates[] = [
      {
        key: "alice:sport",
        candidates: [
          { key: "alice:sport", value: "tennis", timestamp: 100 },
          { key: "alice:sport", value: "football", timestamp: 200 },
        ],
      },
      {
        key: "bob:city",
        candidates: [
          { key: "bob:city", value: "London", timestamp: 50 },
          { key: "bob:city", value: "Paris", timestamp: 150 },
          { key: "bob:city", value: "Berlin", timestamp: 100 },
        ],
      },
    ];

    const results = r.resolveAll(memories);

    expect(results).toHaveLength(2);
    expect(results[0]?.key).toBe("alice:sport");
    expect(results[0]?.winner.value).toBe("football");
    expect(results[1]?.key).toBe("bob:city");
    expect(results[1]?.winner.value).toBe("Paris");
  });

  it("includes losers in each result", () => {
    const r = new ConflictResolver();
    const memories: MemoryCandidates[] = [
      {
        key: "test",
        candidates: [
          { key: "test", value: "old", timestamp: 100 },
          { key: "test", value: "new", timestamp: 200 },
          { key: "test", value: "middle", timestamp: 150 },
        ],
      },
    ];

    const results = r.resolveAll(memories);
    expect(results).toHaveLength(1);
    expect(results[0]!.losers).toHaveLength(2);
    expect(results[0]!.losers.map((l) => l.value)).toContain("old");
    expect(results[0]!.losers.map((l) => l.value)).toContain("middle");
  });

  it("sets resolvedAt timestamp on each result", () => {
    const r = new ConflictResolver();
    const before = Date.now();
    const results = r.resolveAll([
      {
        key: "ts-check",
        candidates: [
          { key: "ts-check", value: "a", timestamp: 1 },
          { key: "ts-check", value: "b", timestamp: 2 },
        ],
      },
    ]);
    const after = Date.now();

    expect(results).toHaveLength(1);
    expect(results[0]!.resolvedAt).toBeGreaterThanOrEqual(before);
    expect(results[0]!.resolvedAt).toBeLessThanOrEqual(after);
  });

  it("skips keys with empty candidates", () => {
    const r = new ConflictResolver();
    const results = r.resolveAll([
      { key: "skip-me", candidates: [] },
    ]);
    expect(results).toHaveLength(0);
  });

  it("handles mixed empty and populated candidates gracefully", () => {
    const r = new ConflictResolver();
    const results = r.resolveAll([
      { key: "empty", candidates: [] },
      {
        key: "valid",
        candidates: [
          { key: "valid", value: "only", timestamp: 99 },
        ],
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("valid");
  });
});

// ─────────────────────────────────────────────
// Integration: track() + resolve()
// ─────────────────────────────────────────────

describe("ConflictResolver: track + resolve integration", () => {
  it("tracked fact is used in resolve via stats tracking", () => {
    const r = new ConflictResolver();
    r.track("user:lang", "TypeScript", 3000);

    const candidates: FactRecord[] = [
      { key: "user:lang", value: "JavaScript", timestamp: 1000 },
      { key: "user:lang", value: "Python", timestamp: 2000 },
    ];

    const winner = r.resolve("user:lang", candidates);
    // The tracked fact has timestamp 3000, but it's not in candidates
    // So the winner should be "Python" (max among candidates)
    expect(winner.value).toBe("Python");

    // Stats should reflect the tracked fact comparison
    const stats = r.getStats("user:lang");
    expect(stats).toBeDefined();
    expect(stats?.totalConflicts).toBe(1);
  });

  it("tracked fact overrides when included in candidates", () => {
    const r = new ConflictResolver();
    r.track("user:lang", "Rust", 5000);

    const candidates: FactRecord[] = [
      { key: "user:lang", value: "JavaScript", timestamp: 1000 },
      { key: "user:lang", value: "Rust", timestamp: 5000 },
    ];

    const winner = r.resolve("user:lang", candidates);
    expect(winner.value).toBe("Rust"); // tracked fact has max timestamp
  });

  it("simulates mem7 recall + conflict resolution flow", () => {
    const r = new ConflictResolver();

    // Phase 1: track facts as they're stored via mem7
    r.track("alice:sport", "tennis", 1000);
    r.track("alice:sport", "football", 3000);

    // Phase 2: later recall returns conflicting facts
    const conflictingMemories: MemoryCandidates[] = [
      {
        key: "alice:sport",
        candidates: [
          { key: "alice:sport", value: "tennis", timestamp: 1000 },
          { key: "alice:sport", value: "football", timestamp: 3000 },
          { key: "alice:sport", value: "basketball", timestamp: 2000 },
        ],
      },
    ];

    const results = r.resolveAll(conflictingMemories);

    expect(results).toHaveLength(1);
    expect(results[0]!.winner.value).toBe("football");
    expect(results[0]!.winner.timestamp).toBe(3000);
    expect(results[0]!.losers).toHaveLength(2);

    // Stats should show tracked fact won
    const stats = r.getStats("alice:sport");
    expect(stats?.trackedWins).toBe(1);
  });
});

// ─────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────

describe("ConflictResolver edge cases", () => {
  it("handles null and undefined values", () => {
    const r = new ConflictResolver();
    r.track("null-val", null, 100);
    expect(r.getTracked("null-val")?.value).toBeNull();

    const candidates: FactRecord[] = [
      { key: "null-val", value: null, timestamp: 100 },
      { key: "null-val", value: undefined, timestamp: 200 },
    ];
    const winner = r.resolve("null-val", candidates);
    expect(winner.value).toBeUndefined();
  });

  it("handles boolean values", () => {
    const r = new ConflictResolver();
    r.track("flag", true, 100);
    r.track("flag", false, 200);
    expect(r.getTracked("flag")?.value).toBe(false);
  });

  it("handles numeric zero and empty string", () => {
    const r = new ConflictResolver();
    r.track("zero-val", 0, 100);
    r.track("empty-str", "", 200);
    expect(r.getTracked("zero-val")?.value).toBe(0);
    expect(r.getTracked("empty-str")?.value).toBe("");
  });

  it("handles array values", () => {
    const r = new ConflictResolver();
    r.track("arr", [1, 2, 3], 100);
    r.track("arr", [4, 5], 200);
    expect(r.getTracked("arr")?.value).toEqual([4, 5]);
  });

  it("clear() resets everything", () => {
    const r = new ConflictResolver({ keepHistory: true });
    r.track("a", 1, 100);
    r.track("b", 2, 200);
    r.resolve("a", [{ key: "a", value: 1, timestamp: 100 }]);
    expect(r.size).toBe(2);
    expect(r.getHistory("a")).toHaveLength(1);
    expect(r.getStats("a")).toBeDefined();

    r.clear();

    expect(r.size).toBe(0);
    expect(r.getHistory("a")).toEqual([]);
    expect(r.getStats("a")).toBeUndefined();
  });

  it("trackedKeys() returns correct keys", () => {
    const r = new ConflictResolver();
    r.track("x", 1, 10);
    r.track("y", 2, 20);
    r.track("z", 3, 30);
    const keys = [...r.trackedKeys()].sort();
    expect(keys).toEqual(["x", "y", "z"]);
  });
});

// ─────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────

describe("ConflictResolver statistics", () => {
  it("tracks total conflicts per key", () => {
    const r = new ConflictResolver();
    r.resolve("cnt", [
      { key: "cnt", value: 1, timestamp: 10 },
      { key: "cnt", value: 2, timestamp: 20 },
    ]);
    r.resolve("cnt", [
      { key: "cnt", value: 3, timestamp: 30 },
      { key: "cnt", value: 4, timestamp: 40 },
    ]);

    expect(r.getStats("cnt")?.totalConflicts).toBe(2);
  });

  it("tracks trackedWins when tracked fact has max timestamp", () => {
    const r = new ConflictResolver();
    r.track("twin", "latest", 500);

    // First resolve: tracked fact not in candidates
    r.resolve("twin", [
      { key: "twin", value: "old", timestamp: 100 },
    ]);
    expect(r.getStats("twin")?.trackedWins).toBe(0);

    // Second resolve: tracked fact IS the max in candidates
    r.resolve("twin", [
      { key: "twin", value: "old", timestamp: 100 },
      { key: "twin", value: "latest", timestamp: 500 },
    ]);
    expect(r.getStats("twin")?.trackedWins).toBe(1);
  });

  it("tracks earliest and latest timestamps", () => {
    const r = new ConflictResolver();
    r.resolve("range", [
      { key: "range", value: "a", timestamp: 100 },
      { key: "range", value: "b", timestamp: 200 },
    ]);
    r.resolve("range", [
      { key: "range", value: "c", timestamp: 300 },
    ]);

    const stats = r.getStats("range");
    expect(stats?.earliest).toBe(100);
    expect(stats?.latest).toBe(300);
  });
});
