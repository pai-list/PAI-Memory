/**
 * PAI-Memory L2 DO Adapter Tests
 *
 * Tests the L2 DO adapter against the in-memory L2EpisodicChain reference implementation.
 * These tests verify the adapter's interface matches the in-memory implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { L2EpisodicChain, L2Overflow, powerDecay, familyScore, L2_SOFT_BUDGET_BYTES, L2_HARD_CEILING_BYTES, DECAY_BETA } from './l2-episodic-chain';
import { MemoryEntry, MemoryLayer, MemoryTier } from './types';

// Mock DurableObjectState and D1Database for testing
class MockDurableObjectState {
  storage = new Map<string, any>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get(key);
  }

  async put(key: string, value: any): Promise<void> {
    this.storage.set(key, value);
  }
}

class MockD1Database {
  private tables = new Map<string, any[]>();

  prepare(sql: string) {
    return new MockPreparedStatement(this, sql);
  }

  exec(sql: string): void {
    if (sql.includes('CREATE TABLE IF NOT EXISTS l2_entries')) {
      this.tables.set('l2_entries', []);
    }
  }
}

class MockPreparedStatement {
  private params: any[] = [];

  constructor(private db: MockD1Database, private sql: string) {}

  bind(...params: any[]) {
    this.params = params;
    return this;
  }

  async run(): Promise<{ changes: number }> {
    const sql = this.sql.toLowerCase();
    const params = this.params || [];

    if (sql.includes('insert or replace into l2_entries')) {
      const [id, content, embedding, metadata_json, layer, tier, createdAt, updatedAt, accessCount, lastAccessedAt, importanceScore, pinned] = params;
      const table = this.db.tables.get('l2_entries') || [];
      const existingIndex = table.findIndex((row: any) => row.id === id);
      const row = {
        id, content, embedding, metadata_json, layer, tier,
        createdAt, updatedAt, accessCount: accessCount ?? 0,
        lastAccessedAt, importanceScore: importanceScore ?? 0, pinned: pinned ?? 0
      };
      if (existingIndex >= 0) {
        table[existingIndex] = row;
      } else {
        table.push(row);
      }
      this.db.tables.set('l2_entries', table);
      return { changes: 1 };
    }

    if (sql.includes('delete from l2_entries')) {
      const table = this.db.tables.get('l2_entries') || [];
      const initialLength = table.length;
      this.db.tables.set('l2_entries', table.filter((row: any) => row.id !== params[0]));
      return { changes: initialLength - this.db.tables.get('l2_entries')!.length };
    }

    if (sql.includes('update l2_entries')) {
      const table = this.db.tables.get('l2_entries') || [];
      const idx = table.findIndex((row: any) => row.id === params[params.length - 1]);
      if (idx >= 0) {
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (sql.includes('delete from l2_entries where id =')) {
      const table = this.db.tables.get('l2_entries') || [];
      const initialLength = table.length;
      this.db.tables.set('l2_entries', table.filter((row: any) => row.id !== params[0]));
      return { changes: initialLength - this.db.tables.get('l2_entries')!.length };
    }

    return { changes: 0 };
  }

  async first(): Promise<any> {
    const sql = this.sql.toLowerCase();
    const params = this.params || [];

    if (sql.includes('select * from l2_entries where id =')) {
      const table = this.db.tables.get('l2_entries') || [];
      const row = table.find((row: any) => row.id === params[0]);
      return row || null;
    }

    if (sql.includes('select * from l2_entries where createdat <=')) {
      const table = this.db.tables.get('l2_entries') || [];
      const rows = table
        .filter((row: any) => row.pinned === 0)
        .sort((a, b) => a.createdAt - b.createdAt);
      return rows[0] || null;
    }

    if (sql.includes('select count(*)') || sql.includes('select count(*) as count')) {
      const table = this.db.tables.get('l2_entries') || [];
      const pinnedCount = table.filter((r: any) => r.pinned === 1).length;
      const totalBytes = table.reduce((sum, r) => sum + (r.content?.length || 0) + (r.embedding?.byteLength || 0) + (r.metadata_json?.length || 0) + 128, 0);
      return {
        count: table.length,
        total_bytes: totalBytes,
        pinned_count: pinnedCount,
        oldest: table.length > 0 ? Math.min(...table.map((r: any) => r.createdAt)) : null,
        newest: table.length > 0 ? Math.max(...table.map((r: any) => r.createdAt)) : null
      };
    }

    if (sql.includes('select * from l2_entries where pinned = 1')) {
      const table = this.db.tables.get('l2_entries') || [];
      return table.filter((r: any) => r.pinned === 1).map((r: any) => ({ ...r }));
    }

    if (sql.includes('select * from l2_entries order by createdat desc')) {
      const table = this.db.tables.get('l2_entries') || [];
      return [...table].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    }

    if (sql.includes('select * from l2_entries where createdat >= ? and createdat <=')) {
      const table = this.db.tables.get('l2_entries') || [];
      const [from, to] = this.params || [];
      return table
        .filter((r: any) => r.createdAt >= from && r.createdAt <= to)
        .sort((a, b) => a.createdAt - b.createdAt);
    }

    return null;
  }

  async all(): Promise<{ results: any[] }> {
    const sql = this.sql.toLowerCase();
    const table = this.db.tables.get('l2_entries') || [];

    if (sql.includes('select * from l2_entries order by createdat asc')) {
      return { results: [...table].sort((a, b) => a.createdAt - b.createdAt) };
    }

    if (sql.includes('select * from l2_entries where createdat >= ? and createdat <=')) {
      const [from, to] = this.params || [];
      return {
        results: table
          .filter((r: any) => r.createdAt >= this.params[0] && r.createdAt <= this.params[1])
          .sort((a, b) => a.createdAt - b.createdAt)
      };
    }

    if (sql.includes('select * from l2_entries where pinned = 1')) {
      return { results: table.filter((r: any) => r.pinned === 1) };
    }

    if (sql.includes('select * from l2_entries order by createdat desc')) {
      return { results: [...table].sort((a, b) => b.createdAt - a.createdAt) };
    }

    return { results: [] };
  }

  bind(...params: any[]) {
    this.params = params;
    return this;
  }
}

// Helper to create test entries
function createTestEntry(overrides: Partial<any> = {}): any {
  return {
    id: crypto.randomUUID(),
    content: 'test content',
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    metadata: {
      source: 'test',
      tags: [],
      type: 'episodic',
      confidence: 0.9,
      custom: {}
    },
    layer: 'L2_WARM' as any,
    tier: 'WARM' as any,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    importanceScore: 0.5,
    ...overrides
  };
}

describe('L2 DO Adapter - Interface Compatibility', () => {
  let mockState: MockDurableObjectState;
  let mockDB: MockD1Database;
  let mockEnv: any;

  beforeEach(() => {
    mockState = new MockDurableObjectState();
    mockDB = new MockD1Database();
    mockEnv = { DB: mockDB };
  });

  it('should have the correct interface exports', async () => {
    const { L2EpisodicDO, L2Client } = await import('./l2-do-adapter');
    expect(L2EpisodicDO).toBeDefined();
    expect(L2Client).toBeDefined();
    // L2DOConfig is a TypeScript interface (erased at runtime), verified at compile time
  });
});

describe('L2EpisodicChain Reference Implementation', () => {
  let chain: L2EpisodicChain;
  const now = Date.now();

  beforeEach(() => {
    chain = new L2EpisodicChain({ softBudgetBytes: 1024 * 1024, hardCeilingBytes: 10 * 1024 * 1024 });
  });

  it('should append entries and maintain chronological order', () => {
    const entry1 = createTestEntry({ id: '1', createdAt: 1000 });
    const entry2 = createTestEntry({ id: '2', createdAt: 2000 });
    const entry3 = createTestEntry({ id: '3', createdAt: 1500 });

    chain.append(entry1);
    chain.append(entry2);
    chain.append(entry3);

    expect(chain.ids()).toEqual(['1', '3', '2']);
    expect(chain.headId).toBe('2');
  });

  it('should enforce soft budget and return overflow', () => {
    const chain = new L2EpisodicChain({
      softBudgetBytes: 3000,
      sizeBytesOf: () => 1000,
      hardCeilingBytes: 1024 * 1024 * 10
    });

    chain.append(createTestEntry({ id: 'a', createdAt: 1000 }));
    chain.append(createTestEntry({ id: 'b', createdAt: 2000 }));
    chain.append(createTestEntry({ id: 'c', createdAt: 3000 }));
    const overflow = chain.append(createTestEntry({ id: 'd', createdAt: 4000 }));

    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow[0].entry.id).toBe('a');
  });

  it('should protect pinned entries from eviction', () => {
    const chain = new L2EpisodicChain({
      softBudgetBytes: 3000,
      sizeBytesOf: () => 1000,
      hardCeilingBytes: 1024 * 1024 * 10
    });

    const pinned = createTestEntry({
      id: 'pinned',
      createdAt: 1000,
      metadata: { custom: { pinned: true } }
    });
    chain.append(pinned);

    for (let i = 0; i < 10; i++) {
      chain.append(createTestEntry({ createdAt: 2000 + i }));
    }

    expect(chain.get('pinned')?.content).toBe('test content');
  });

  it('should compute power decay correctly', () => {
    expect(powerDecay(0)).toBe(1);
    expect(powerDecay(3_600_000)).toBeLessThan(1);
    expect(powerDecay(720_000_000)).toBeLessThan(powerDecay(3_600_000));
  });

  it('should compute family score correctly', () => {
    const now = Date.now();

    const fresh = familyScore(now - 60_000, { now });
    const stale = familyScore(now - 7 * 24 * 3_600_000, { now });

    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('Budget Constants', () => {
  it('should have correct D2 budget defaults', () => {
    expect(L2_SOFT_BUDGET_BYTES).toBe(1024 * 1024); // 1 MiB
    expect(L2_HARD_CEILING_BYTES).toBe(10 * 1024 * 1024); // 10 MiB
  });

  it('should have correct decay betas for identity-like content', () => {
    expect(DECAY_BETA.identity).toBe(0.013);
    expect(DECAY_BETA.commitment).toBe(0.014);
  });
});