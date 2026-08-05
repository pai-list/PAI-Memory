/**
 * PAI-Memory L3 DO-SQLite Adapter
 *
 * Spec: docs/PAI-MEM-L3-SPEC.md §1–§7. Parent: docs/PAI-MEM-SPEC.md §3 (L3),
 * §4 numerics cascade, §5 power-law decay, §6 the clock decides, D2/D3/D4, D6.
 *
 * Durable Object with SQLite persistence for L3 Facts/Semantic Graph.
 * The in-memory L3FactGraph becomes a client; this DO handles durability,
 * budget enforcement, and restart recovery.
 *
 * D2 Budgets: soft=100 MiB, hard=500 MiB. Pins survive soft overflow.
 * SQLite schema: l3_facts (id, fact_key, content, serial, valid_from, valid_to,
 * embedding, mat256, int8_data, int8_mean, int8_scale, metadata_json,
 * layer, tier, createdAt, updatedAt, accessCount, lastAccessedAt, importanceScore, pinned, novelty)
 */

import { MemoryLayer, MemoryTier, L3Overflow, L3DOConfig } from './types';
import { FactRecord, Int8Quantization, toInt8Params, fromInt8Params, L3OverflowReason } from './l3-facts-semantic';
import { DurableObjectState } from '@cloudflare/workers-types';

export interface L3EntryRow {
  id: string;
  factKey: string;
  content: string;
  serial: number;
  validFrom: number;
  validTo: number | null;
  embedding: Float32Array | null;
  mat256: Float32Array | null;
  int8Data: Uint8Array | null;
  int8Mean: Float32Array | null;
  int8Scale: Float32Array | null;
  metadata_json: string;
  layer: MemoryLayer;
  tier: MemoryTier;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  pinned: number; // 0 or 1
  novelty: string;
}

class L3FactGraphDO {
  private state: DurableObjectState;
  private env: any;
  private db: any; // D1Database or Sqlite
  private config: L3DOConfig;
  private softBudget: number;
  private hardCeiling: number;

  constructor(state: DurableObjectState, env: any, config: L3DOConfig = {}) {
    this.state = state;
    this.env = env;
    this.config = config;
    this.softBudget = config.softBudgetBytes ?? 100 * 1024 * 1024; // 100 MiB default
    this.hardCeiling = config.hardCeilingBytes ?? 500 * 1024 * 1024; // 500 MiB default
  }

  // Initialize the DO: create table, load state
  async initialize(): Promise<void> {
    // Get D1 database from bindings (injected via wrangler)
    this.db = this.env.DB;

    // Create table if not exists
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS l3_facts (
        id TEXT PRIMARY KEY,
        fact_key TEXT NOT NULL,
        content TEXT NOT NULL,
        serial INTEGER NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        embedding BLOB,
        mat256 BLOB,
        int8_data BLOB,
        int8_mean BLOB,
        int8_scale BLOB,
        metadata_json TEXT NOT NULL,
        layer TEXT NOT NULL,
        tier TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        accessCount INTEGER NOT NULL DEFAULT 0,
        lastAccessedAt INTEGER NOT NULL,
        importanceScore REAL NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        novelty TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_l3_factKey ON l3_facts(fact_key);
      CREATE INDEX IF NOT EXISTS idx_l3_createdAt ON l3_facts(createdAt);
      CREATE INDEX IF NOT EXISTS idx_l3_pinned ON l3_facts(pinned);
      CREATE INDEX IF NOT EXISTS idx_l3_lastAccessed ON l3_facts(lastAccessedAt);
      CREATE INDEX IF NOT EXISTS idx_l3_validTo ON l3_facts(valid_to);
    `);

    // Load budget config from storage if exists
    const stored = await this.state.storage.get<{ soft: number; hard: number }>('budget');
    if (stored) {
      this.softBudget = stored.soft;
      this.hardCeiling = stored.hard;
    }

    // Verify budget integrity on startup
    await this.verifyBudgetIntegrity();
  }

  private async verifyBudgetIntegrity(): Promise<void> {
    const { results } = await this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(
          LENGTH(content) +
          COALESCE(LENGTH(embedding), 0) +
          COALESCE(LENGTH(mat256), 0) +
          COALESCE(LENGTH(int8_data), 0) +
          COALESCE(LENGTH(int8_mean), 0) +
          COALESCE(LENGTH(int8_scale), 0) +
          LENGTH(metadata_json) + 128
        ), 0) as total_bytes
      FROM l3_facts
    `).all();

    const count = results[0].count as number;
    const totalBytes = results[0].total_bytes as number;

    // Log for monitoring
    console.log(`[L3DO] Startup: ${count} facts, ${totalBytes} bytes (soft=${this.softBudget}, hard=${this.hardCeiling})`);

    // If over hard ceiling, trigger emergency eviction
    if (totalBytes > this.hardCeiling) {
      console.warn(`[L3DO] Over hard ceiling on startup: ${totalBytes} > ${this.hardCeiling}`);
      await this.enforceBudget();
    }
  }

  // ── Public API (called by L3Client) ──

  /** Upsert a fact; returns overflow entries for promotion */
  async upsert(entry: FactRecord): Promise<L3Overflow[]> {
    const now = Date.now();
    const metadataJson = JSON.stringify(entry.metadata);
    const embeddingBlob = entry.embedding ? new Float32Array(entry.embedding).buffer : null;
    const mat256Blob = entry.mat256 ? new Float32Array(entry.mat256).buffer : null;
    const int8DataBlob = entry.int8.data ? new Uint8Array(entry.int8.data).buffer : null;
    const int8MeanBlob = entry.int8.mean ? new Float32Array(entry.int8.mean).buffer : null;
    const int8ScaleBlob = entry.int8.scale ? new Float32Array(entry.int8.scale).buffer : null;
    const pinned = entry.pinned ? 1 : 0;

    await this.db.prepare(`
      INSERT OR REPLACE INTO l3_facts
      (id, fact_key, content, serial, valid_from, valid_to,
       embedding, mat256, int8_data, int8_mean, int8_scale,
       metadata_json, layer, tier, createdAt, updatedAt,
       accessCount, lastAccessedAt, importanceScore, pinned, novelty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.factKey,
      entry.content,
      entry.serial,
      entry.validFrom,
      entry.validTo,
      embeddingBlob,
      mat256Blob,
      int8DataBlob,
      int8MeanBlob,
      int8ScaleBlob,
      metadataJson,
      entry.layer,
      entry.tier,
      entry.createdAt,
      entry.updatedAt ?? now,
      entry.accessCount ?? 0,
      entry.lastAccessedAt ?? now,
      entry.importanceScore ?? 0,
      pinned,
      entry.novelty
    ).run();

    return this.enforceBudget();
  }

  /** Get a fact by ID */
  async get(id: string, opts?: { returnNullFact?: boolean }): Promise<FactRecord | null> {
    if (opts?.returnNullFact) return null;
    
    const row = await this.db.prepare(`
      SELECT * FROM l3_facts WHERE id = ?
    `).bind(id).first();

    if (!row) return null;
    return this.rowToFact(row);
  }

  /** Get multiple facts by IDs */
  async getMany(ids: string[]): Promise<FactRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db.prepare(`
      SELECT * FROM l3_facts WHERE id IN (${placeholders})
    `).bind(...ids).all();

    return results.map((row: any) => this.rowToFact(row));
  }

  /** Get all facts (for export/promotion) */
  async getAll(): Promise<FactRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l3_facts ORDER BY createdAt ASC
    `).all();

    return results.map((row: any) => this.rowToFact(row));
  }

  /** Slice facts by time range */
  async slice(fromMs: number, toMs: number): Promise<FactRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l3_facts
      WHERE createdAt >= ? AND createdAt <= ?
      ORDER BY createdAt ASC
    `).bind(fromMs, toMs).all();

    return results.map((row: any) => this.rowToFact(row));
  }

  /** Update access count and last accessed time */
  async touch(id: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare(`
      UPDATE l3_facts
      SET accessCount = accessCount + 1, lastAccessedAt = ?, updatedAt = ?
      WHERE id = ?
    `).bind(Date.now(), Date.now(), id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Remove a fact (forget — requires humanConfirm per D4) */
  async forget(id: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM l3_facts WHERE id = ?
    `).bind(id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Set pin status */
  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE l3_facts SET pinned = ? WHERE id = ?
    `).bind(pinned ? 1 : 0, id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Check if pinned */
  async isPinned(id: string): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT pinned FROM l3_facts WHERE id = ?
    `).bind(id).first();

    return (row?.pinned ?? 0) === 1;
  }

  /** Get all pinned facts */
  async getPinned(): Promise<FactRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l3_facts WHERE pinned = 1 ORDER BY createdAt ASC
    `).all();

    return results.map((row: any) => this.rowToFact(row));
  }

  /** Get facts sorted by family score for recall */
  async choose(contentType: string, now: number, limit: number = 100): Promise<{ id: string; txnMs: number; score: number }[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l3_facts
      ORDER BY createdAt DESC
      LIMIT ?
    `).bind(limit * 5).all(); // Fetch more for scoring

    const entries = results.map((row: any) => this.rowToFact(row));
    const { factScore } = await import('./l3-facts-semantic.js');

    return entries
      .map((e: FactRecord) => {
        const score = factScore(e.createdAt, {
          contentType: contentType ?? e.metadata.contentType,
          importance: e.importanceScore,
          accesses: e.accessCount ?? 0,
          lastAccessMs: e.lastAccessedAt,
          now,
        });
        return { id: e.id, txnMs: e.createdAt, score };
      })
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, limit);
  }

  /** Get current stats */
  async getStats(): Promise<{
    count: number;
    sizeBytes: number;
    softBudget: number;
    hardCeiling: number;
    pinnedCount: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  }> {
    const row = await this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(
          LENGTH(content) +
          COALESCE(LENGTH(embedding), 0) +
          COALESCE(LENGTH(mat256), 0) +
          COALESCE(LENGTH(int8_data), 0) +
          COALESCE(LENGTH(int8_mean), 0) +
          COALESCE(LENGTH(int8_scale), 0) +
          LENGTH(metadata_json) + 128
        ), 0) as total_bytes,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_count,
        MIN(createdAt) as oldest,
        MAX(createdAt) as newest
      FROM l3_facts
    `).first();

    if (!row) {
      return {
        count: 0,
        sizeBytes: 0,
        softBudget: this.softBudget,
        hardCeiling: this.hardCeiling,
        pinnedCount: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }

    return {
      count: row.count as number,
      sizeBytes: row.total_bytes as number,
      softBudget: this.softBudget,
      hardCeiling: this.hardCeiling,
      pinnedCount: row.pinned_count as number,
      oldestEntry: row.oldest as number | null,
      newestEntry: row.newest as number | null,
    };
  }

  /** Update budget configuration */
  async setBudget(soft: number, hard: number): Promise<void> {
    this.softBudget = soft;
    this.hardCeiling = hard;
    await this.state.storage.put('budget', { soft, hard });
    await this.enforceBudget();
  }

  // ── Private: Budget Enforcement ──

  private async enforceBudget(): Promise<L3Overflow[]> {
    const overflows: L3Overflow[] = [];

    // Get current size
    const stats = await this.getStats();
    let over = stats.sizeBytes - this.softBudget;
    if (over <= 0) return overflows;

    let freed = 0;
    let guard = 0;

    // Evict oldest unpinned until under hard ceiling OR under soft budget
    while ((stats.sizeBytes > this.hardCeiling || (over > 0 && freed < 64)) && guard < 1000) {
      // Find oldest unpinned
      const row = await this.db.prepare(`
        SELECT id FROM l3_facts
        WHERE pinned = 0
        ORDER BY createdAt ASC
        LIMIT 1
      `).first();

      if (!row) break; // All pinned - stop

      const reason: L3OverflowReason = stats.sizeBytes > this.hardCeiling ? 'budget' : 'budget';

      // Get the entry before deletion for overflow return
      const entry = await this.get(row.id);
      if (entry) {
        overflows.push(this.toOverflow(entry, reason));
      }

      await this.db.prepare(`DELETE FROM l3_facts WHERE id = ?`).bind(row.id).run();
      freed++;
      guard++;

      // Refresh stats
      const newStats = await this.getStats();
      stats.sizeBytes = newStats.sizeBytes;
      over = stats.sizeBytes - this.softBudget;
    }

    return overflows;
  }

  // ── Helpers ──

  private toOverflow(f: FactRecord, reason: L3OverflowReason): L3Overflow {
    return {
      factKey: f.factKey,
      serial: f.serial,
      embedding: new Float32Array(f.embedding),
      mat256: new Float32Array(f.mat256),
      int8Params: toInt8Params(f.int8),
      reason,
    };
  }

  private rowToFact(row: any): FactRecord {
    const metadata = JSON.parse(row.metadata_json);
    const embedding = row.embedding
      ? Array.from(new Float32Array(row.embedding))
      : [];
    const mat256 = row.mat256
      ? Array.from(new Float32Array(row.mat256))
      : [];

    const int8Data = row.int8_data
      ? new Uint8Array(row.int8_data)
      : new Uint8Array(0);
    const int8Mean = row.int8_mean
      ? Array.from(new Float32Array(row.int8_mean))
      : [];
    const int8Scale = row.int8_scale
      ? Array.from(new Float32Array(row.int8_scale))
      : [];

    return {
      id: row.id,
      factKey: row.fact_key,
      content: row.content,
      serial: row.serial,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      embedding: Float32Array.from(embedding),
      mat256: Float32Array.from(mat256),
      int8: {
        data: new Int8Array(int8Data.buffer, int8Data.byteOffset, int8Data.byteLength),
        mean: Float32Array.from(int8Mean),
        scale: Float32Array.from(int8Scale),
      },
      metadata,
      novelty: row.novelty as FactRecord['novelty'],
      layer: row.layer as MemoryLayer,
      tier: row.tier as MemoryTier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      accessCount: row.accessCount ?? 0,
      lastAccessedAt: row.lastAccessedAt,
      importanceScore: row.importanceScore ?? 0,
      pinned: row.pinned === 1,
    };
  }
}

/** Client-side wrapper for talking to L3FactGraphDO */
class L3Client {
  private doStub: DurableObjectStub;
  private localCache: Map<string, FactRecord> = new Map();
  private cacheTTL = 5000; // 5 second cache

  constructor(doStub: DurableObjectStub) {
    this.doStub = doStub;
  }

  async upsert(entry: FactRecord): Promise<L3Overflow[]> {
    const result = await this.doStub.upsert(entry);
    this.localCache.delete(entry.id);
    return result;
  }

  async get(id: string, opts?: { returnNullFact?: boolean }): Promise<FactRecord | null> {
    const cached = this.localCache.get(id);
    if (cached) return cached;

    const entry = await this.doStub.get(id, opts);
    if (entry) this.localCache.set(id, entry);
    return entry;
  }

  async getMany(ids: string[]): Promise<FactRecord[]> {
    return this.doStub.getMany(ids);
  }

  async slice(fromMs: number, toMs: number): Promise<FactRecord[]> {
    return this.doStub.slice(fromMs, toMs);
  }

  async touch(id: string): Promise<boolean> {
    const result = await this.doStub.touch(id);
    this.localCache.delete(id);
    return result;
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.doStub.forget(id);
    this.localCache.delete(id);
    return result;
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const result = await this.doStub.setPinned(id, pinned);
    this.localCache.delete(id);
    return result;
  }

  async isPinned(id: string): Promise<boolean> {
    return this.doStub.isPinned(id);
  }

  async choose(contentType: string, now: number, limit?: number): Promise<{ id: string; txnMs: number; score: number }[]> {
    return this.doStub.choose(contentType, now, limit);
  }

  async getStats(): Promise<any> {
    return this.doStub.getStats();
  }

  async setBudget(soft: number, hard: number): Promise<void> {
    return this.doStub.setBudget(soft, hard);
  }

  async export(): Promise<FactRecord[]> {
    return this.doStub.getAll();
  }
}

// Type for DurableObjectStub with our methods
interface DurableObjectStub {
  upsert(entry: any): Promise<any[]>;
  get(id: string, opts?: { returnNullFact?: boolean }): Promise<any>;
  getMany(ids: string[]): Promise<any[]>;
  slice(fromMs: number, toMs: number): Promise<any[]>;
  touch(id: string): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  setPinned(id: string, pinned: boolean): Promise<boolean>;
  isPinned(id: string): Promise<boolean>;
  choose(contentType: string, now: number, limit?: number): Promise<any[]>;
  getStats(): Promise<any>;
  setBudget(soft: number, hard: number): Promise<void>;
  getAll(): Promise<any[]>;
}

export { L3FactGraphDO, L3Client };
export type { L3DOConfig } from './types';
export type { L3OverflowReason } from './l3-facts-semantic';