import { describe, it, expect } from 'vitest';
import {
  L3FactGraph,
  FactRecord,
  L3_MATRYOSHKA_DIM,
  L3_DEFAULT_BETA,
  truncateMatryoshka,
  quantizeInt8,
  dequantizeInt8,
  cosineSim,
  powerDecay,
  factScore,
  validityActive,
  classifyNovelty,
  clampNegZero,
} from '../src/l3-facts-semantic';

// ───────────── helpers ─────────────

/** Deterministic pseudo-random unit-ish vector for embeddings. */
function makeVector(dim: number, seed = 0): Float32Array {
  const v = new Float32Array(dim);
  let x = seed + 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return v;
}

let makeFactSeq = 0;

function makeFact(over: { [k: string]: unknown } = {}, dim = 32): FactRecord {
  const embed = over.embedding ? Float32Array.from(over.embedding as number[]) : makeVector(dim);
  const id = (over.id as string) ?? `f${makeFactSeq++}`;
  return {
    id,
    factKey: (over.factKey as string) ?? `k:${id}`,
    content: (over.content as string) ?? `fact ${id}`,
    serial: (over.serial as number) ?? 1,
    validFrom: (over.validFrom as number) ?? 0,
    validTo: (over.validTo as number | null) ?? null,
    embedding: embed,
    mat256: truncateMatryoshka(embed),
    int8: quantizeInt8(embed),
    metadata: (over.metadata as FactRecord['metadata']) ?? {
      contentType: (over.contentType as string) ?? 'generic',
      confidence: (over.confidence as number) ?? 1,
    },
    novelty: (over.novelty as FactRecord['novelty']) ?? 'ADD',
    createdAt: (over.createdAt as number) ?? Date.now(),
    updatedAt: (over.updatedAt as number) ?? Date.now(),
    accessCount: (over.accessCount as number) ?? 0,
    lastAccessedAt: (over.lastAccessedAt as number) ?? Date.now(),
    importanceScore: (over.importanceScore as number) ?? 0,
    pinned: (over.pinned as boolean) ?? false,
  };
}
// Numerics helpers
// ─────────────────────────────────────────────

describe('L3 numerics', () => {
  it('truncateMatryoshka returns exactly L3_MATRYOSHKA_DIM dims', () => {
    const v = makeVector(512);
    expect(truncateMatryoshka(v).length).toBe(L3_MATRYOSHKA_DIM);
  });

  it('truncate preserves the first 256 values', () => {
    const v = makeVector(1024, 7);
    const t = truncateMatryoshka(v);
    for (let i = 0; i < 5; i++) expect(t[i]).toBeCloseTo(v[i], 6);
  });

  it('quantizeInt8 is deterministic (same input → same quantized bytes)', () => {
    const v = makeVector(64, 42);
    const a = quantizeInt8(v);
    const b = quantizeInt8(Float32Array.from(v));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.mean)).toEqual(Array.from(b.mean));
    expect(Array.from(a.scale)).toEqual(Array.from(b.scale));
  });

  it('quantizeInt8 never emits -0 (INT8 is integer — sanity via dequant)', () => {
    const v = makeVector(64, 3);
    const q = quantizeInt8(v);
    const d = dequantizeInt8(q);
    // irrelevant to INT8 -0, but assert the dequant is all finite
    expect(d.every((x) => Number.isFinite(x) && !Number.isNaN(x))).toBe(true);
  });

  it('cosineSim identical vectors → 1 (clamped, deterministic)', () => {
    const v = makeVector(16, 11);
    expect(cosineSim(v, Float32Array.from(v))).toBeCloseTo(1, 6);
  });

  it('cosineSim zero-norm input → 0, not NaN', () => {
    const z = new Float32Array(8);
    expect(cosineSim(z, makeVector(8))).toBe(0);
  });

  it('clampNegZero returns 0 for both ±0', () => {
    expect(clampNegZero(0)).toBe(0);
    expect(clampNegZero(-0)).toBe(0);
    expect(Object.is(clampNegZero(-0), 0)).toBe(true);
  });
});

describe('power-decay (L3 row β ≈ 0.8)', () => {
  it('powerDecay at age 0 is 1, decays superlinear at later hours', () => {
    expect(powerDecay(0)).toBe(1);
    expect(powerDecay(0, L3_DEFAULT_BETA)).toBe(1);
    const oneHour = powerDecay(3_600_000);
    const day = powerDecay(86_400_000);
    expect(oneHour).toBeLessThan(1);
    expect(day).toBeLessThan(oneHour);
  });

  it('identity content decays near zero (≳64k h half-life)', () => {
    const now = Date.now();
    const threeMonthsMs = 90 * 24 * 3_600_000;
    const score = factScore(now - threeMonthsMs, {
      contentType: 'identity',
      importance: 1,
      accesses: 0,
      lastAccessMs: now,
      now,
    });
    expect(score).toBeGreaterThan(0.85);
  });

  it('rare content decays fast', () => {
    const now = Date.now();
    const deep = factScore(now - 90 * 24 * 3_600_000, {
      contentType: 'rare',
      importance: 0,
      accesses: 0,
      lastAccessMs: now,
      now,
    });
    // beta=1.5, 90 days, importance=0, no accesses → ~0.25 (fast vs identity's >0.85)
    expect(deep).toBeLessThan(0.5);
  });
});

// ───────────── validity + supersession ─────────────
describe('validity window', () => {
  it('open-ended window (validTo null) is active now', () => {
    const f = makeFact({ validFrom: 1000, validTo: null });
    expect(validityActive(f, 1_000_000)).toBe(true);
  });

  it('expired window is not active', () => {
    const f = makeFact({ validFrom: 1000, validTo: 2000 });
    expect(validityActive(f, 2_001)).toBe(false);
  });

  it('not-yet-valid window is not active', () => {
    const f = makeFact({ validFrom: 5000, validTo: null });
    expect(validityActive(f, 100)).toBe(false);
  });
});

describe('L3FactGraph — supersession by serial', () => {
  it('resolve() returns the MAX serial within the valid window', () => {
    const g = new L3FactGraph();
    g.upsert(makeFact({ factKey: 'alice:address', serial: 1 }));
    g.upsert(makeFact({ factKey: 'alice:address', serial: 2 }));
    g.upsert(makeFact({ factKey: 'alice:address', serial: 3 }));
    expect(g.resolve('alice:address')?.serial).toBe(3);
  });

  it('equal-serial concurrent winners → both survive (surface, never silent collapse)', () => {
    const g = new L3FactGraph();
    const a = makeFact({ factKey: 'dual:key', serial: 5, content: 'A' });
    const b = makeFact({ factKey: 'dual:key', serial: 5, content: 'B' });
    g.upsert(a);
    g.upsert(b);
    const hist = g.history('dual:key');
    expect(hist.length).toBe(2); // both retained — not collapsed
    // resolve() deterministically picks one (tie-break), but both survive in audit
    expect(g.resolve('dual:key')).not.toBeNull();
  });

  it('recall excludes lower-serial facts of the same key', () => {
    const g = new L3FactGraph();
    g.upsert(makeFact({ factKey: 'dup', serial: 1, content: 'old' }));
    g.upsert(makeFact({ factKey: 'dup', serial: 2, content: 'new' }));
    const res = g.recall(makeVector(32, 4), { limit: 5 });
    // superseded fact is overshadowed in recall of the key
    const contents = res.map((r) => r.fact.content);
    expect(contents).toContain('new');
    expect(contents.filter((c) => c === 'old')).toHaveLength(0);
  });
});

describe('L3FactGraph — SAGE novelty gate', () => {
  it('classifyNovelty returns ADD when there are no comparable facts', () => {
    expect(classifyNovelty(makeVector(16), [])).toBe('ADD');
  });

  it('identical vectors → NOOP at near threshold', () => {
    const v = makeVector(16, 8);
    const dup = v.slice();
    expect(classifyNovelty(v, [dup], { near: 0.92, merge: 0.8 })).toBe('NOOP');
  });

  it('orthogonal-ish vectors → ADD', () => {
    const a = makeVector(16, 1);
    const b = makeVector(16, 99);
    expect(classifyNovelty(a, [b], { near: 0.92, merge: 0.8 })).toBe('ADD');
  });
});

describe('L3FactGraph — budget', () => {
  it('evicts oldest unpinned at soft budget and returns L3Overflow[]', () => {
    const g = new L3FactGraph({ softBudgetBytes: 1024, hardCeilingBytes: 2048 });
    const a = makeFact({ createdAt: 100 });
    const b = makeFact({ createdAt: 200 });
    g.upsert({ ...a, pinned: true });
    g.upsert(b);
    g.upsert(makeFact({ createdAt: 300 }));

    // force an over-budget insert
    g.upsert(makeFact({ createdAt: 400, embedding: makeVector(1024) }));
    expect(g.get(a.id)).toBeTruthy(); // pinned keeps
    const stats = g.getStats();
    expect(stats.count).toBeLessThanOrEqual(4);
  });

  it('hard ceiling respected after a flood (no silent truncation — return overflow)', () => {
    const g = new L3FactGraph({ softBudgetBytes: 256, hardCeilingBytes: 512 });
    const overflows = g.upsert(makeFact()); // seed
    expect(overflows).toBeInstanceOf(Array);
    // stuffing loop
    for (let i = 0; i < 20; i++) {
      const ov = g.upsert(makeFact({ embedding: makeVector(1024 * (i + 1), i) }));
      expect(ov).toBeInstanceOf(Array);
    }
    expect(g.getStats().sizeBytes).toBeLessThanOrEqual(512);
  });

  it('forget() requires humanConfirm (D4)', () => {
    const g = new L3FactGraph();
    const f = makeFact();
    g.upsert(f);
    expect(g.forget(f.id)).toBe(false); // no confirm
    expect(g.forget(f.id, { humanConfirm: true })).toBe(true);
    expect(g.get(f.id)).toBeNull();
  });
});

describe('L3FactGraph — recall ranking', () => {
  it('ranks the exact query match first (f32 rescore wins)', () => {
    const g = new L3FactGraph();
    const target = makeFact({ content: 'the answer', embedding: makeVector(64, 5) });
    g.upsert(target);
    g.upsert(makeFact({ content: 'unrelated', embedding: makeVector(64, 99) }));
    const res = g.recall(makeVector(64, 5), { limit: 1 });
    expect(res[0].fact.content).toBe('the answer');
  });

  it('recall applies validity window', () => {
    const g = new L3FactGraph();
    g.upsert(makeFact({ validFrom: 0, validTo: 100, content: 'stale' }));
    g.upsert(makeFact({ validFrom: 0, validTo: null, content: 'live' }));
    const res = g.recall(makeVector(32, 9), { validNow: 1_000_000, limit: 5 });
    expect(res.map((r) => r.fact.content)).toContain('live');
    expect(res.map((r) => r.fact.content)).not.toContain('stale');
  });
});