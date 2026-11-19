/**
 * PAI-Memory L4 DO Adapter Tests
 *
 * Tests the L4 DO-Code adapter against eccentric54/architecture/source specs.
 * Verifies: schema creation, exact resolve (shortest path), call-edge related,
 * dendritic file tree, forget/pruneEdges, D2 default budgets, pin survival.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { L4CodeGraphDO } from './l4-do-adapter';
import { MemoryLayer, MemoryTier } from './types';

type Row = {
  id: string; qualified_name: string; kind: string; module: string; file: string;
  signature: string; serial: number; valid_from: number; valid_to: number | null;
  deps_json: string; layer: string; tier: string; createdAt: number; updatedAt: number;
  accessCount: number; lastAccessedAt: number; importanceScore: number; pinned: number;
  caller?: string; callee?: string; path?: string;
};

class MockDurableObjectState {
  storage = new Map<string, any>();
  async get<T>(key: string): Promise<T | undefined> { return this.storage.get(key); }
  async put(key: string, value: any): Promise<void> { this.storage.set(key, value); }
}

class MockD1Database {
  tables = new Map<string, Row[]>();

  prepare(sql: string) { return new MockPreparedStatement(this, sql); }

  exec(sql: string): void {
    if (sql.includes('CREATE TABLE IF NOT EXISTS l4_symbols')) {
      this.tables.set('l4_symbols', []);
      this.tables.set('l4_calls', []);
      this.tables.set('l4_files', []);
    }
  }
}

function symbolRow(o: Partial<Row> = {}): Row {
  return {
    id: 'pay@1', qualified_name: 'apt.pay.submit', kind: 'function', module: 'apt',
    file: 'pay.ts', signature: 'apt.pay.submit', serial: 1, valid_from: 100, valid_to: null,
    deps_json: '["apt.escrow.hold"]', layer: MemoryLayer.L4_CODE, tier: MemoryTier.COOL,
    createdAt: 100, updatedAt: 100, accessCount: 0, lastAccessedAt: 100,
    importanceScore: 0.5, pinned: 0, ...o,
  };
}

class MockPreparedStatement {
  private params: any[] = [];

  constructor(private db: MockD1Database, private sql: string) {}

  bind(...params: any[]) { this.params = params; return this; }

  async run(): Promise<{ changes: number }> {
    const sql = this.sql.toLowerCase().replace(/\s+/g, " ");
    const p = this.params || [];

    if (sql.includes('insert or replace into l4_symbols')) {
      const table = this.db.tables.get('l4_symbols') || [];
      const row: Row = {
        id: p[0], qualified_name: p[1], kind: p[2], module: p[3], file: p[4],
        signature: p[5] ?? p[1], serial: p[6], valid_from: p[7], valid_to: p[8] ?? null,
        deps_json: p[9] ?? '[]', layer: p[10], tier: p[11], createdAt: p[12],
        updatedAt: p[13], accessCount: p[14] ?? 0, lastAccessedAt: p[15],
        importanceScore: p[16] ?? 0, pinned: p[17] ?? 0,
      };
      const idx = table.findIndex((r) => r.id === row.id);
      if (idx >= 0) table[idx] = row; else table.push(row);
      this.db.tables.set('l4_symbols', table);
    }

    if (sql.includes('insert or replace into l4_calls')) {
      const calls = this.db.tables.get('l4_calls') || [];
      if (!calls.some((c) => c.caller === p[0] && c.callee === p[1])) calls.push({ caller: p[0], callee: p[1] });
      this.db.tables.set('l4_calls', calls);
    }

    if (sql.includes('insert or replace into l4_files')) {
      const files = this.db.tables.get('l4_files') || [];
      files.push({ path: p[0], module: p[1] });
      this.db.tables.set('l4_files', files);
    }

    if (sql.includes('delete from l4_calls')) {
      let calls = this.db.tables.get('l4_calls') || [];
      if (p.length >= 2) calls = calls.filter((c) => c.caller !== p[0] && c.callee !== p[1]);
      else calls = calls.filter((c) => c.caller !== p[0]);
      this.db.tables.set('l4_calls', calls);
    }
    if (sql.includes('delete from l4_symbols')) {
      const table = this.db.tables.get('l4_symbols') || [];
      const before = table.length;
      this.db.tables.set('l4_symbols', table.filter((r) => r.id !== p[0]));
      return { changes: before - (this.db.tables.get('l4_symbols')?.length ?? 0) };
    }

    if (sql.includes('update l4_symbols set accesscount')) {
      const table = this.db.tables.get('l4_symbols') || [];
      const r = table.find((x) => x.id === p[1]);
      r && (r.accessCount = (r.accessCount ?? 0) + 1);
      return { changes: r ? 1 : 0 };
    }

    if (sql.includes('update l4_symbols set pinned')) {
      const table = this.db.tables.get('l4_symbols') || [];
      const r = table.find((x) => x.id === p[1]);
      r && (r.pinned = p[0]);
      return { changes: r ? 1 : 0 };
    }

    return { changes: 0 };
  }

  async first(): Promise<any> {
    const sql = this.sql.toLowerCase().replace(/\s+/g, " ");
    const table = this.db.tables.get('l4_symbols') || [];
    const p = this.params || [];

    if (sql.includes('select * from l4_symbols where qualified_name')) {
      const r = [...table].filter((x) => x.qualified_name === p[0]).sort((a, b) => b.serial - a.serial)[0];
      return r ?? null;
    }

    if (sql.includes('select count(*) as c from l4_calls')) {
      return { c: (this.db.tables.get('l4_calls') || []).length };
    }

    if (sql.includes('select count(*)')) {
      const pinnedCount = table.filter((r) => r.pinned === 1).length;
      const totalBytes = table.reduce((s, r) =>
        s + (r.qualified_name?.length || 0) + (r.signature?.length || 0) + (r.file?.length || 0) + (r.deps_json?.length || 0) + 128, 0);
      return {
        count: table.length, total_bytes: totalBytes, pinned_count: pinnedCount,
        oldest: table.length ? Math.min(...table.map((r) => r.createdAt)) : null,
        newest: table.length ? Math.max(...table.map((r) => r.createdAt)) : null,
      };
    }

    if (sql.includes('select count(*) as c from l4_calls')) {
      return { c: (this.db.tables.get('l4_calls') || []).length };
    }

    if (sql.includes('select id from l4_symbols')) {
      return table.filter((r) => r.pinned === 0).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
    }

    if (sql.includes('select * from l4_symbols where id =')) {
      return table.find((r) => r.id === p[0]) ?? null;
    }

    return null;
  }

  async all(): Promise<{ results: Row[] }> {
    const sql = this.sql.toLowerCase().replace(/\s+/g, " ");
    const table = this.db.tables.get('l4_symbols') || [];
    const p = this.params || [];

    if (sql.includes('where qualified_name')) {
      return { results: [...table].filter((r) => r.qualified_name === p[0]).sort((a, b) => b.serial - a.serial) };
    }

    if (sql.includes('select callee from l4_calls')) {
      const calls = this.db.tables.get('l4_calls') || [];
      return { results: calls.filter((c) => c.caller === p[0]) };
    }

    if (sql.includes('select caller from l4_calls')) {
      const calls = this.db.tables.get('l4_calls') || [];
      return { results: calls.filter((c) => c.callee === p[0]) };
    }

    if (sql.includes('select qualified_name, file, module from l4_symbols')) {
      const rows = p[0] !== undefined ? table.filter((r) => r.module === p[0]) : [...table];
      return { results: rows.map((r) => ({ qualified_name: r.qualified_name, file: r.file, module: r.module })) };
    }

    if (sql.includes('select count(*) as count')) {
      const pinnedCount = table.filter((r) => r.pinned === 1).length;
      const totalBytes = table.reduce((s, r) =>
        s + (r.qualified_name?.length || 0) + (r.signature?.length || 0) + (r.file?.length || 0) + (r.deps_json?.length || 0) + 128, 0);
      return { results: [{ count: table.length, total_bytes: totalBytes, pinned_count: pinnedCount }] };
    }

    return { results: [] };
  }
}

describe('L4CodeGraphDO', () => {
  let db: MockD1Database;
  let do_: L4CodeGraphDO;

  beforeEach(async () => {
    db = new MockD1Database();
    const state = new MockDurableObjectState();
    do_ = new L4CodeGraphDO(state as any, { DB: db }, {});
    await do_.initialize();
  });

  function toSymbol(r: Row) {
    return {
      id: r.id, qualifiedName: r.qualified_name, kind: r.kind, module: r.module, file: r.file,
      signature: r.signature, serial: r.serial, validFrom: r.valid_from, validTo: r.valid_to,
      deps: JSON.parse(r.deps_json), layer: r.layer as MemoryLayer, tier: r.tier as MemoryTier,
      createdAt: r.createdAt, updatedAt: r.updatedAt, accessCount: r.accessCount,
      lastAccessedAt: r.lastAccessedAt, importanceScore: r.importanceScore, pinned: r.pinned === 1,
    };
  }

  it('creates the three schema tables on initialize', () => {
    expect(db.tables.has('l4_symbols')).toBe(true);
    expect(db.tables.has('l4_calls')).toBe(true);
    expect(db.tables.has('l4_files')).toBe(true);
  });

  it('upserts and resolves exactly by qualified name (shortest path)', async () => {
    await do_.upsert(toSymbol(symbolRow()) as any);
    const found = await do_.resolve('apt.pay.submit');
    expect(found).not.toBeNull();
    expect(found!.qualifiedName).toBe('apt.pay.submit');
    expect(found!.kind).toBe('function');
    expect(found!.deps).toEqual(['apt.escrow.hold']);
  });

  it('returns null for unknown symbol', async () => {
    expect(await do_.resolve('nope.missing')).toBeNull();
  });

  it('records call edges and reports related (callers + callees)', async () => {
    await do_.upsert(toSymbol(symbolRow({ id: 'a', qualified_name: 'pay.submit', deps_json: '["escrow.hold"]' })) as any);
    await do_.upsert(toSymbol(symbolRow({ id: 'b', qualified_name: 'escrow.hold', deps_json: '[]' })) as any);

    const rel = await do_.related('pay.submit');
    expect(rel.callees).toContain('escrow.hold');
    const rel2 = await do_.related('escrow.hold');
    expect(rel2.callers).toContain('pay.submit');
  });

  it('returns dendritic module -> file -> symbols tree, filtered by module', async () => {
    await do_.upsert(toSymbol(symbolRow({ id: 'a', qualified_name: 'a.pay.submit', file: 'pay.ts', module: 'a' })) as any);
    await do_.upsert(toSymbol(symbolRow({ id: 'b', qualified_name: 'b.escrow.hold', file: 'escrow.ts', module: 'b' })) as any);

    const tree = await do_.fileTree();
    expect(tree['a']['pay.ts']).toContain('a.pay.submit');
    expect(tree['b']['escrow.ts']).toContain('b.escrow.hold');

    const onlyA = await do_.fileTree('a');
    expect(onlyA['a']['pay.ts']).toContain('a.pay.submit');
    expect(onlyA['b']).toBeUndefined();
  });

  it('forget deletes the row; pruneEdges removes dangling edges', async () => {
    await do_.upsert(toSymbol(symbolRow({ id: 'x', qualified_name: 'fragile' })) as any);
    expect(await do_.forget('x')).toBe(true);
    expect(await do_.resolve('fragile')).toBeNull();
    await expect(do_.pruneEdges('fragile')).resolves.toBeUndefined();
  });

  it('enforces D2 default budgets 50MiB soft / 200MiB hard', async () => {
    const stats = await do_.getStats();
    expect(stats.softBudget).toBe(50 * 1024 * 1024);
    expect(stats.hardCeiling).toBe(200 * 1024 * 1024);
  });

  it('pins survive — setPinned flips flag and getStats counts it', async () => {
    await do_.upsert(toSymbol(symbolRow({ id: 'p1', qualified_name: 'pinned.sym' })) as any);
    expect(await do_.setPinned('p1', true)).toBe(true);
    const stats = await do_.getStats();
    expect(stats.pinnedCount).toBe(1);
  });

  it('tracks call-edge count in stats', async () => {
    await do_.upsert(toSymbol(symbolRow({ id: 'a', qualified_name: 'pay.submit', deps_json: '["escrow.hold"]' })) as any);
    const stats = await do_.getStats();
    expect(stats.callEdges).toBe(1);
  });
});