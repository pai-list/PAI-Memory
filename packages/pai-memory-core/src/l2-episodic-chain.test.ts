import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  L2EpisodicChain,
  powerDecay,
  familyScore,
  DECAY_BETA,
  L2_SOFT_BUDGET_BYTES,
  L2_HARD_CEILING_BYTES,
} from './l2-episodic-chain';

type Entry = Parameters<L2EpisodicChain['append']>[0];

function entry(partial: Partial<Entry> = {}): Entry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    content: partial.content ?? 'episode',
    embedding: [],
    metadata: {
      source: 'test',
      tags: [],
      type: 'context',
      confidence: 0.5,
      custom: {},
    },
    layer: 'L2_WARM' as any,
    tier: 'WARM' as any,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.createdAt ?? now,
    accessCount: partial.accessCount ?? 0,
    lastAccessedAt: partial.lastAccessedAt ?? now,
    importanceScore: 0,
    ...partial,
  };
}

/** A chain where every entry claims a fixed size (deterministic budgets). */
function sized(soft: number, each: number) {
  return new L2EpisodicChain({ softBudgetBytes: soft, sizeBytesOf: () => each });
}

describe('powerDecay (§5.1)', () => {
  it('age zero → 1', () => {
    expect(powerDecay(0)).toBe(1);
  });

  it('monotonically decreasing with age', () => {
    const young = powerDecay(1 * 3_600_000, { contentType: 'episodic' });
    const old = powerDecay(30 * 24 * 3_600_000, { contentType: 'episodic' });
    expect(young).toBeGreaterThan(old);
  });

  it('identity/commitment near-zero decay (spec §5.1)', () => {
    const identity = powerDecay(90 * 24 * 3_600_000, { contentType: 'identity' });
    const rare = powerDecay(90 * 24 * 3_600_000, { contentType: 'rare' });
    expect(identity).toBeGreaterThan(rare);
    expect(identity).toBeGreaterThan(0.9); // "≳64k h half-life"
  });

  it('episodic default β = 1.2 (L2 default)', () => {
    expect(DECAY_BETA.episodic).toBe(1.2);
  });
});

describe('familyScore (§5.2)', () => {
  const now = 1_700_000_000_000;

  it('importance boosts', () => {
    const hi = familyScore(now - 3_600_000, { importance: 0.9, now });
    const lo = familyScore(now - 3_600_000, { importance: 0.1, now });
    expect(hi).toBeGreaterThan(lo);
  });

  it('recency term boosts fresh memory', () => {
    const fresh = familyScore(now - 60_000, { now });
    const stale = familyScore(now - 7 * 24 * 3_600_000, { now });
    expect(fresh).toBeGreaterThan(stale);
  });

  it('rehearsal (accessCount) boosts', () => {
    const zero = familyScore(now - 3_600_000, { accesses: 0, now });
    const many = familyScore(now - 3_600_000, { accesses: 10, now });
    expect(many).toBeGreaterThan(zero);
  });

  it('bounded in [0,1]', () => {
    const s = familyScore(now - 1, { importance: 1, accesses: 1000, now });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('L2EpisodicChain — chronological chain', () => {
  let chain: L2EpisodicChain;
  beforeEach(() => { chain = new L2EpisodicChain(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps chronological order (sorting, not insertion)', () => {
    const a = entry({ content: 'a', createdAt: 1000 });
    const b = entry({ content: 'b', createdAt: 2000 });
    const c = entry({ content: 'c', createdAt: 1500 });
    chain.append(a); chain.append(b); chain.append(c);
    expect(chain.ids()).toEqual([a.id, c.id, b.id]);
    expect(chain.headId).toBe(b.id);
    expect(chain.count).toBe(3);
  });

  it('nearestBefore → newest entry with createdAt ≤ ts', () => {
    const a = entry({ content: 'a', createdAt: 1000 });
    const b = entry({ content: 'b', createdAt: 2000 });
    chain.append(a); chain.append(b);
    expect(chain.nearestBefore(2500)?.id).toBe(b.id);
    expect(chain.nearestBefore(1500)?.id).toBe(a.id);
    expect(chain.nearestBefore(500)).toBeNull();
  });

  it('slice() returns chronological window', () => {
    chain.append(entry({ content: 'x', createdAt: 1000 }));
    chain.append(entry({ content: 'y', createdAt: 2000 }));
    chain.append(entry({ content: 'z', createdAt: 3000 }));
    const win = chain.slice(1500, 2500);
    expect(win).toHaveLength(1);
    expect(win[0]?.content).toBe('y');
  });

  it('forget removes by id', () => {
    const e = entry({ content: 'gone' });
    chain.append(e);
    expect(chain.forget(e.id)).toBe(true);
    expect(chain.forget(e.id)).toBe(false);
    expect(chain.get(e.id)).toBeNull();
  });

  it('choose() ranks by familyScore', () => {
    vi.setSystemTime(1_700_000_000_000);
    const now = Date.now();
    chain.append(entry({ content: 'old', createdAt: now - 10 * 24 * 3_600_000 }));
    chain.append(entry({ content: 'fresh', createdAt: now - 60_000 }));
    const ranked = chain.choose('context', now);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0);
    expect(ranked[0]?.id).toBe(chain.ids()[1]); // the freshest
  });
});

describe('L2EpisodicChain — budget enforcement (D2)', () => {
  it('evicts OLDEST unpinned under soft-overflow, returns promotable', () => {
    const chain = sized(3000, 1000);
    const a = entry({ content: 'a', createdAt: 1000 });
    const b = entry({ content: 'b', createdAt: 2000 });
    const c = entry({ content: 'c', createdAt: 3000 });
    chain.append(a); chain.append(b); chain.append(c); // 3000 = soft → ok
    expect(chain.ids()).toHaveLength(3);

    const overflow = chain.append(entry({ content: 'd', createdAt: 4000 })); // 4000 > 3000
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow[0].entry.id).toBe(a.id); // oldest promoted, not dropped
    expect(chain.get(a.id)).toBeNull();
    expect(chain.get(b.id)).not.toBeNull();
  });

  it('PINS are never evicted by soft overflow (right-of-user)', () => {
    const chain = sized(3000, 1000);
    const pinned = entry({ content: 'P', createdAt: 1000, metadata: { ...entry().metadata, custom: { pinned: true } } });
    chain.append(pinned);
    for (let i = 0; i < 10; i++) chain.append(entry({ content: `f${i}`, createdAt: 2000 + i * 100 }));
    expect(chain.get(pinned.id)?.content).toBe('P');
    expect(chain.isPinned(pinned.id)).toBe(true);
  });

  it('respects hard ceiling as upper bound even with pins', () => {
    const chain = new L2EpisodicChain({
      softBudgetBytes: 500,
      hardCeilingBytes: 1200,
      sizeBytesOf: () => 1000,
    });
    const pinned = entry({ content: 'anchor', createdAt: 1, metadata: { ...entry().metadata, custom: { pinned: true } } });
    chain.append(pinned); // 1000 ≤ soft appends, pinned survives soft-over-reach
    const overflow = chain.append(entry({ content: 'x', createdAt: 2 }));
    // total 2000 > hard 1200 → evict x; anchor pinned survives
    expect(overflow).toHaveLength(1);
    expect(overflow[0].entry.content).toBe('x');
    expect(overflow[0].reasons).toBe('hard-cap');
    expect(chain.get(pinned.id)?.content).toBe('anchor');
    expect(chain.sizeBytes).toBe(1000); // down under hard ceiling
  });

  it('defaults per D2 (1 MiB soft / 10 MiB hard)', () => {
    expect(L2_SOFT_BUDGET_BYTES).toBe(1024 * 1024);
    expect(L2_HARD_CEILING_BYTES).toBe(10 * 1024 * 1024);
    const d = new L2EpisodicChain();
    expect(d.sizeBytes).toBe(0);
  });
});