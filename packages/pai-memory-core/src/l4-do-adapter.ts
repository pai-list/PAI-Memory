/**
 * PAI-Memory L4 DO-SQLite Adapter
 *
 * Spec: docs/PAI-MEM-L4-SPEC.md §1–§5. Parent: docs/PAI-MEM-SPEC.md §3 (L4),
 * §4.3 index by topology (exact short-circuit), §5 near-persist decay,
 * §6 the clock decides, D2/D3/D4, D6.
 *
 * Durable Object with SQLite persistence for L4 Procedural/Code Call-Graph.
 * The in-memory L4CodeGraph becomes a client; this DO handles durability,
 * budget enforcement, and restart recovery.
 *
 * D2 Budgets: soft=50 MiB, hard=200 MiB.
 * SQLite schema: l4_symbols (id, qualified_name, kind, module, file,
 * signature, serial, valid_from, valid_to, deps_json, layer, tier,
 * createdAt, updatedAt, accessCount, lastAccessedAt, importanceScore, pinned),
 * l4_calls (caller, callee), l4_files (path, module).
 */

import { MemoryLayer, MemoryTier } from './types';
import type { SymbolRecord } from './l4-code-graph';
import { DurableObjectState } from '@cloudflare/workers-types';

export interface L4EntryRow {
  id: string;
  qualifiedName: string;
  kind: string;
  module: string;
  file: string;
  signature: string;
  serial: number;
  validFrom: number;
  validTo: number | null;
  deps: string[];
  layer: MemoryLayer;
  tier: MemoryTier;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  pinned: number;
}

export interface L4DOConfig {
  softBudgetBytes?: number;
  hardCeilingBytes?: number;
}

export type L4OverflowReason = 'budget' | 'superseded' | 'expired';

export interface L4Overflow {
  qualifiedName: string;
  serial: number;
  reason: L4OverflowReason;
}

class L4CodeGraphDO {
  private state: DurableObjectState;
  private env: any;
  private db: any;
  private config: L4DOConfig;
  private softBudget: number;
  private hardCeiling: number;

  constructor(state: DurableObjectState, env: any, config: L4DOConfig = {}) {
    this.state = state;
    this.env = env;
    this.config = config;
    this.softBudget = config.softBudgetBytes ?? 50 * 1024 * 1024; // 50 MiB default
    this.hardCeiling = config.hardCeilingBytes ?? 200 * 1024 * 1024; // 200 MiB default
  }

  async initialize(): Promise<void> {
    this.db = this.env.DB;

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS l4_symbols (
        id TEXT PRIMARY KEY,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        module TEXT NOT NULL,
        file TEXT NOT NULL,
        signature TEXT NOT NULL,
        serial INTEGER NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        deps_json TEXT NOT NULL,
        layer TEXT NOT NULL,
        tier TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        accessCount INTEGER NOT NULL DEFAULT 0,
        lastAccessedAt INTEGER NOT NULL,
        importanceScore REAL NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS l4_calls (
        caller TEXT NOT NULL,
        callee TEXT NOT NULL,
        PRIMARY KEY (caller, callee)
      );

      CREATE TABLE IF NOT EXISTS l4_files (
        path TEXT PRIMARY KEY,
        module TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_l4_name ON l4_symbols(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_l4_module ON l4_symbols(module);
      CREATE INDEX IF NOT EXISTS idx_l4_file ON l4_symbols(file);
      CREATE INDEX IF NOT EXISTS idx_l4_createdAt ON l4_symbols(createdAt);
    `);

    const stored = await this.state.storage.get<{ soft: number; hard: number }>('budget');
    if (stored) {
      this.softBudget = stored.soft;
      this.hardCeiling = stored.hard;
    }

    await this.verifyBudgetIntegrity();
  }

  private async verifyBudgetIntegrity(): Promise<void> {
    const { results } = await this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(
          LENGTH(qualified_name) +
          LENGTH(signature) +
          LENGTH(file) +
          LENGTH(deps_json) + 128
        ), 0) as total_bytes
      FROM l4_symbols
    `).all();

    const count = results[0].count as number;
    const totalBytes = results[0].total_bytes as number;

    console.log(`[L4DO] Startup: ${count} symbols, ${totalBytes} bytes (soft=${this.softBudget}, hard=${this.hardCeiling})`);

    if (totalBytes > this.hardCeiling) {
      console.warn(`[L4DO] Over hard ceiling on startup: ${totalBytes} > ${this.hardCeiling}`);
      await this.enforceBudget();
    }
  }

  // ── Public API ──

  /** Upsert a symbol; returns overflow entries for promotion */
  async upsert(entry: SymbolRecord): Promise<L4Overflow[]> {
    const now = Date.now();
    const depsJson = JSON.stringify(entry.deps);

    await this.db.prepare(`
      INSERT OR REPLACE INTO l4_symbols
      (id, qualified_name, kind, module, file, signature, serial,
       valid_from, valid_to, deps_json, layer, tier, createdAt, updatedAt,
       accessCount, lastAccessedAt, importanceScore, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.qualifiedName,
      entry.kind,
      entry.module,
      entry.file,
      entry.signature ?? entry.qualifiedName,
      entry.serial,
      entry.validFrom,
      entry.validTo,
      depsJson,
      entry.layer,
      entry.tier,
      entry.createdAt,
      entry.updatedAt ?? now,
      entry.accessCount ?? 0,
      entry.lastAccessedAt ?? now,
      entry.importanceScore ?? 0,
      entry.pinned ? 1 : 0
    ).run();

    // Refresh call edges: wipe + rewrite for this caller
    await this.db.prepare(`DELETE FROM l4_calls WHERE caller = ?`).bind(entry.qualifiedName).run();
    for (const dep of entry.deps) {
      await this.db.prepare(`
        INSERT OR REPLACE INTO l4_calls (caller, callee) VALUES (?, ?)
      `).bind(entry.qualifiedName, dep).run();
    }

    await this.db.prepare(`
      INSERT OR REPLACE INTO l4_files (path, module) VALUES (?, ?)
    `).bind(entry.file, entry.module).run();

    return this.enforceBudget();
  }

  /** Exact lookup by qualified name (primary path — no embedding) */
  async resolve(qualifiedName: string): Promise<L4EntryRow | null> {
    const row = await this.db.prepare(`
      SELECT * FROM l4_symbols WHERE qualified_name = ?
      ORDER BY serial DESC LIMIT 1
    `).bind(qualifiedName).first();

    if (!row) return null;
    await this.db.prepare(`
      UPDATE l4_symbols SET accessCount = accessCount + 1, lastAccessedAt = ?
      WHERE id = ?
    `).bind(Date.now(), row.id).run();
    return this.rowToEntry(row);
  }

  /** Get all versions of a name (bitemporal history) */
  async versions(qualifiedName: string): Promise<L4EntryRow[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l4_symbols WHERE qualified_name = ? ORDER BY serial DESC
    `).bind(qualifiedName).all();
    return results.map((row: any) => this.rowToEntry(row));
  }

  /** Callers + callees */
  async related(qualifiedName: string): Promise<{ callers: string[]; callees: string[] }> {
    const calleesRes = await this.db.prepare(`
      SELECT callee FROM l4_calls WHERE caller = ?
    `).bind(qualifiedName).all();

    const callersRes = await this.db.prepare(`
      SELECT caller FROM l4_calls WHERE callee = ?
    `).bind(qualifiedName).all();

    return {
      callers: (callersRes.results as any[]).map((r) => r.caller),
      callees: (calleesRes.results as any[]).map((r) => r.callee),
    };
  }

  /** Module -> file -> symbols (dendritic tree) */
  async fileTree(module?: string): Promise<Record<string, Record<string, string[]>>> {
    let rows;
    if (module) {
      rows = await this.db.prepare(`
        SELECT qualified_name, file, module FROM l4_symbols WHERE module = ?
      `).bind(module).all();
    } else {
      rows = await this.db.prepare(`
        SELECT qualified_name, file, module FROM l4_symbols
      `).all();
    }

    const tree: Record<string, Record<string, string[]>> = {};
    for (const r of rows.results as any[]) {
      (tree[r.module] ??= {})[r.file] ??= [];
      tree[r.module][r.file].push(r.qualified_name);
    }
    return tree;
  }

  /** D4: dependency-aware forget — requires humanConfirm checked by caller */
  async forget(id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM l4_symbols WHERE id = ?`).bind(id).run();
    return (result.changes ?? 0) > 0;
  }

  /** Set pin status (pins survive soft overflow) */
  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE l4_symbols SET pinned = ? WHERE id = ?
    `).bind(pinned ? 1 : 0, id).run();
    return (result.changes ?? 0) > 0;
  }

  async getStats(): Promise<{
    count: number;
    sizeBytes: number;
    softBudget: number;
    hardCeiling: number;
    pinnedCount: number;
    callEdges: number;
  }> {
    const row = await this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(
          LENGTH(qualified_name) + LENGTH(signature) + LENGTH(file) + LENGTH(deps_json) + 128
        ), 0) as total_bytes,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_count
      FROM l4_symbols
    `).first();

    const edges = await this.db.prepare(`SELECT COUNT(*) as c FROM l4_calls`).first();

    return {
      count: row?.count as number ?? 0,
      sizeBytes: row?.total_bytes as number ?? 0,
      softBudget: this.softBudget,
      hardCeiling: this.hardCeiling,
      pinnedCount: row?.pinned_count as number ?? 0,
      callEdges: edges?.c as number ?? 0,
    };
  }

  async setBudget(soft: number, hard: number): Promise<void> {
    this.softBudget = soft;
    this.hardCeiling = hard;
    await this.state.storage.put('budget', { soft, hard });
    await this.enforceBudget();
  }

  /** Remove stale edges for a symbol on supersede/forget */
  async pruneEdges(qualifiedName: string): Promise<void> {
    await this.db.prepare(`DELETE FROM l4_calls WHERE caller = ? OR callee = ?`)
      .bind(qualifiedName, qualifiedName).run();
  }

  // ── Private: Budget Enforcement ──

  private async enforceBudget(): Promise<L4Overflow[]> {
    const overflows: L4Overflow[] = [];

    const stats = await this.getStats();
    let over = stats.sizeBytes - this.softBudget;
    if (over <= 0) return overflows;

    let freed = 0;
    let guard = 0;

    while ((stats.sizeBytes > this.hardCeiling || (over > 0 && freed < 64)) && guard < 1000) {
      const row = await this.db.prepare(`
        SELECT id FROM l4_symbols
        WHERE pinned = 0
        ORDER BY createdAt ASC
        LIMIT 1
      `).first();

      if (!row) break;

      const entry = await this.db.prepare(`SELECT * FROM l4_symbols WHERE id = ?`).bind(row.id).first();
      if (entry) {
        overflows.push({
          qualifiedName: entry.qualified_name,
          serial: entry.serial,
          reason: 'budget' as L4OverflowReason,
        });
        await this.pruneEdges(entry.qualified_name);
      }

      await this.db.prepare(`DELETE FROM l4_symbols WHERE id = ?`).bind(row.id).run();
      freed++;
      guard++;

      const newStats = await this.getStats();
      stats.sizeBytes = newStats.sizeBytes;
      over = stats.sizeBytes - this.softBudget;
    }

    return overflows;
  }

  // ── Helpers ──

  private rowToEntry(row: any): L4EntryRow {
    return {
      id: row.id,
      qualifiedName: row.qualified_name,
      kind: row.kind,
      module: row.module,
      file: row.file,
      signature: row.signature,
      serial: row.serial,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      deps: JSON.parse(row.deps_json),
      layer: row.layer as MemoryLayer,
      tier: row.tier as MemoryTier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      accessCount: row.accessCount ?? 0,
      lastAccessedAt: row.lastAccessedAt,
      importanceScore: row.importanceScore ?? 0,
      pinned: row.pinned === 1 ? 1 : 0,
    };
  }
}

/** Client-side wrapper for talking to L4CodeGraphDO */
class L4Client {
  private doStub: DurableObjectStub;
  private localCache: Map<string, L4EntryRow> = new Map();

  constructor(doStub: DurableObjectStub) {
    this.doStub = doStub;
  }

  async upsert(entry: any): Promise<L4Overflow[]> {
    const result = await this.doStub.upsert(entry);
    this.localCache.delete(entry.qualifiedName);
    return result;
  }

  async resolve(qualifiedName: string): Promise<L4EntryRow | null> {
    const cached = this.localCache.get(qualifiedName);
    if (cached) return cached;
    const entry = await this.doStub.resolve(qualifiedName);
    if (entry) this.localCache.set(qualifiedName, entry);
    return entry;
  }

  async versions(qualifiedName: string): Promise<L4EntryRow[]> {
    return this.doStub.versions(qualifiedName);
  }

  async related(qualifiedName: string): Promise<{ callers: string[]; callees: string[] }> {
    return this.doStub.related(qualifiedName);
  }

  async fileTree(module?: string): Promise<any> {
    return this.doStub.fileTree(module);
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.doStub.forget(id);
    this.localCache.clear();
    return result;
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    return this.doStub.setPinned(id, pinned);
  }

  async getStats(): Promise<any> {
    return this.doStub.getStats();
  }

  async setBudget(soft: number, hard: number): Promise<void> {
    return this.doStub.setBudget(soft, hard);
  }
}

interface DurableObjectStub {
  upsert(entry: any): Promise<L4Overflow[]>;
  resolve(qualifiedName: string): Promise<any>;
  versions(qualifiedName: string): Promise<any[]>;
  related(qualifiedName: string): Promise<{ callers: string[]; callees: string[] }>;
  fileTree(module?: string): Promise<any>;
  forget(id: string): Promise<boolean>;
  setPinned(id: string, pinned: boolean): Promise<boolean>;
  getStats(): Promise<any>;
  setBudget(soft: number, hard: number): Promise<void>;
  pruneEdges(qualifiedName: string): Promise<void>;
}

export { L4CodeGraphDO, L4Client };