/**
 * PAI-Memory L2 DO-SQLite Adapter
 *
 * Spec: docs/PAI-MEM-SPEC.md §3 (L2), §5.1/5.2/5.3/5.5, D2, D6, D7.
 *
 * Durable Object with SQLite persistence for L2 Episodic Chain.
 * The in-memory L2EpisodicChain becomes a client; this DO handles durability,
 * budget enforcement, and restart recovery.
 *
 * D2 Budgets: soft=1 MiB, hard=10 MiB. Pins survive soft overflow.
 * SQLite schema: entries (id, content, embedding, metadata, layer, tier, createdAt, updatedAt, accessCount, lastAccessedAt, importanceScore, metadata_json, pinned)
 */

import { MemoryEntry, MemoryLayer, MemoryTier, L2Overflow } from './types';

export interface L2DOConfig {
  softBudgetBytes?: number;
  hardCeilingBytes?: number;
}

export interface L2DOState {
  entries: Map<string, L2EntryRow>;
  softBudget: number;
  hardCeiling: number;
}

export interface L2EntryRow {
  id: string;
  content: string;
  embedding: Float32Array | null;
  metadata_json: string;
  layer: MemoryLayer;
  tier: MemoryTier;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  pinned: number; // 0 or 1
}

class L2EpisodicDO {
  private state: DurableObjectState;
  private env: any;
  private db: any; // D1Database or Sqlite
  private config: L2DOConfig;
  private softBudget: number;
  private hardCeiling: number;

  constructor(state: DurableObjectState, env: any, config: L2DOConfig = {}) {
    this.state = state;
    this.env = env;
    this.config = config;
    this.softBudget = config.softBudgetBytes ?? 1024 * 1024; // 1 MiB default
    this.hardCeiling = config.hardCeilingBytes ?? 10 * 1024 * 1024; // 10 MiB default
  }

  // Initialize the DO: create table, load state
  async initialize(): Promise<void> {
    // Get D1 database from bindings (injected via wrangler)
    this.db = this.env.DB;

    // Create table if not exists
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB,
        metadata_json TEXT NOT NULL,
        layer TEXT NOT NULL,
        tier TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        accessCount INTEGER NOT NULL DEFAULT 0,
        lastAccessedAt INTEGER NOT NULL,
        importanceScore REAL NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_l2_createdAt ON l2_entries(createdAt);
      CREATE INDEX IF NOT EXISTS idx_l2_pinned ON l2_entries(pinned);
      CREATE INDEX IF NOT EXISTS idx_l2_lastAccessed ON l2_entries(lastAccessedAt);
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
          COALESCE((SELECT LENGTH(embedding) FROM pragma_table_info('l2_entries') WHERE name='embedding'), 0) +
          LENGTH(metadata_json) + 128
        ), 0) as total_bytes
      FROM l2_entries
    `).all();

    const count = results[0].count as number;
    const totalBytes = results[0].total_bytes as number;

    // Log for monitoring
    console.log(`[L2DO] Startup: ${count} entries, ${totalBytes} bytes (soft=${this.softBudget}, hard=${this.hardCeiling})`);

    // If over hard ceiling, trigger emergency eviction
    if (totalBytes > this.hardCeiling) {
      console.warn(`[L2DO] Over hard ceiling on startup: ${totalBytes} > ${this.hardCeiling}`);
      await this.enforceBudget();
    }
  }

  // ── Public API (called by L2Client) ──

  /** Append an entry; returns overflow entries for L3 promotion */
  async append(entry: MemoryEntry): Promise<L2Overflow[]> {
    const now = Date.now();
    const metadataJson = JSON.stringify(entry.metadata);
    const embeddingBlob = entry.embedding && entry.embedding.length > 0
      ? new Float32Array(entry.embedding).buffer
      : null;
    const pinned = (entry.metadata.custom?.pinned === true) ? 1 : 0;

    await this.db.prepare(`
      INSERT OR REPLACE INTO l2_entries
      (id, content, embedding, metadata_json, layer, tier, createdAt, updatedAt,
       accessCount, lastAccessedAt, importanceScore, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.content,
      embeddingBlob,
      JSON.stringify(entry.metadata),
      entry.layer,
      entry.tier,
      entry.createdAt,
      entry.updatedAt ?? now,
      entry.accessCount ?? 0,
      entry.lastAccessedAt ?? now,
      entry.importanceScore ?? 0,
      pinned
    ).run();

    return this.enforceBudget();
  }

  /** Get an entry by ID */
  async get(id: string): Promise<MemoryEntry | null> {
    const row = await this.db.prepare(`
      SELECT * FROM l2_entries WHERE id = ?
    `).bind(id).first();

    if (!row) return null;
    return this.rowToEntry(row);
  }

  /** Get multiple entries by IDs */
  async getMany(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db.prepare(`
      SELECT * FROM l2_entries WHERE id IN (${placeholders})
    `).bind(...ids).all();

    return results.map((row: any) => this.rowToEntry(row));
  }

  /** Get all entries (for export/promotion) */
  async getAll(): Promise<MemoryEntry[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l2_entries ORDER BY createdAt ASC
    `).all();

    return results.map((row: any) => this.rowToEntry(row));
  }

  /** Slice entries by time range */
  async slice(fromMs: number, toMs: number): Promise<MemoryEntry[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l2_entries
      WHERE createdAt >= ? AND createdAt <= ?
      ORDER BY createdAt ASC
    `).bind(fromMs, toMs).all();

    return results.map((row: any) => this.rowToEntry(row));
  }

  /** Find newest entry at or before timestamp */
  async nearestBefore(atMs: number): Promise<MemoryEntry | null> {
    const row = await this.db.prepare(`
      SELECT * FROM l2_entries
      WHERE createdAt <= ?
      ORDER BY createdAt DESC
      LIMIT 1
    `).bind(atMs).first();

    return row ? this.rowToEntry(row) : null;
  }

  /** Update access count and last accessed time */
  async touch(id: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare(`
      UPDATE l2_entries
      SET accessCount = accessCount + 1, lastAccessedAt = ?, updatedAt = ?
      WHERE id = ?
    `).bind(Date.now(), Date.now(), id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Remove an entry (forget) */
  async forget(id: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM l2_entries WHERE id = ?
    `).bind(id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Set pin status */
  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE l2_entries SET pinned = ? WHERE id = ?
    `).bind(pinned ? 1 : 0, id).run();

    return (result.changes ?? 0) > 0;
  }

  /** Check if pinned */
  async isPinned(id: string): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT pinned FROM l2_entries WHERE id = ?
    `).bind(id).first();

    return (row?.pinned ?? 0) === 1;
  }

  /** Get all pinned entries */
  async getPinned(): Promise<MemoryEntry[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM l2_entries WHERE pinned = 1 ORDER BY createdAt ASC
    `).all();

    return results.map((row: any) => this.rowToEntry(row));
  }

  /** Get entries sorted by family score for recall */
  async choose(contentType: string, now: number, limit: number = 100): Promise<{ id: string; txnMs: number; score: number }[]> {
    // For efficiency, we fetch recent entries and score in memory
    // In production, consider adding a materialized view or scoring column
    const { results } = await this.db.prepare(`
      SELECT * FROM l2_entries
      ORDER BY createdAt DESC
      LIMIT ?
    `).bind(limit * 5).all(); // Fetch more for scoring

    const entries = results.map((row: any) => this.rowToEntry(row));
    const { familyScore } = await import('./l2-episodic-chain.js');

    return entries
      .map((e: any) => {
        const score = familyScore(e.createdAt, {
          contentType: contentType ?? (e.metadata as any)?.type,
          importance: (e.metadata as any)?.confidence ?? 0,
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
    const { results } = await this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(
          LENGTH(content) +
          COALESCE(LENGTH(embedding), 0) +
          LENGTH(metadata_json) + 128
        ), 0) as total_bytes,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_count,
        MIN(createdAt) as oldest,
        MAX(createdAt) as newest
      FROM l2_entries
    `).first();

    const row = results[0];
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

  private async enforceBudget(): Promise<L2Overflow[]> {
    const overflows: L2Overflow[] = [];

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
        SELECT id FROM l2_entries
        WHERE pinned = 0
        ORDER BY createdAt ASC
        LIMIT 1
      `).first();

      if (!row) break; // All pinned - stop

      const reason: L2Overflow['reasons'] = stats.sizeBytes > this.hardCeiling ? 'hard-cap' : 'budget';

      // Get the entry before deletion for overflow return
      const entry = await this.get(row.id);
      if (entry) {
        overflows.push({ entry, reasons: reason });
      }

      await this.db.prepare(`DELETE FROM l2_entries WHERE id = ?`).bind(row.id).run();
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

  private rowToEntry(row: any): MemoryEntry {
    const metadata = JSON.parse(row.metadata_json);
    const embedding = row.embedding
      ? Array.from(new Float32Array(row.embedding))
      : [];

    return {
      id: row.id,
      content: row.content,
      embedding,
      metadata: {
        ...metadata,
        custom: { ...metadata.custom, pinned: row.pinned === 1 }
      },
      layer: row.layer,
      tier: row.tier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      accessCount: row.accessCount ?? 0,
      lastAccessedAt: row.lastAccessedAt,
      importanceScore: row.importanceScore ?? 0,
    };
  }
}

/** Client-side wrapper for talking to L2EpisodicDO */
class L2Client {
  private doStub: DurableObjectStub;
  private localCache: Map<string, MemoryEntry> = new Map();
  private cacheTTL = 5000; // 5 second cache

  constructor(doStub: DurableObjectStub) {
    this.doStub = doStub;
  }

  async append(entry: MemoryEntry): Promise<L2Overflow[]> {
    const result = await this.doStub.append(entry);
    // Invalidate cache for affected entries
    this.localCache.delete(entry.id);
    return result;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    // Check cache first
    const cached = this.localCache.get(id);
    if (cached) return cached;

    const entry = await this.doStub.get(id);
    if (entry) this.localCache.set(id, entry);
    return entry;
  }

  async getMany(ids: string[]): Promise<MemoryEntry[]> {
    return this.doStub.getMany(ids);
  }

  async slice(fromMs: number, toMs: number): Promise<MemoryEntry[]> {
    return this.doStub.slice(fromMs, toMs);
  }

  async nearestBefore(atMs: number): Promise<MemoryEntry | null> {
    return this.doStub.nearestBefore(atMs);
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

  async export(): Promise<MemoryEntry[]> {
    return this.doStub.getAll();
  }
}

// Type for DurableObjectStub with our methods
interface DurableObjectStub {
  append(entry: any): Promise<any[]>;
  get(id: string): Promise<any>;
  getMany(ids: string[]): Promise<any[]>;
  slice(fromMs: number, toMs: number): Promise<any[]>;
  nearestBefore(atMs: number): Promise<any>;
  touch(id: string): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  setPinned(id: string, pinned: boolean): Promise<boolean>;
  isPinned(id: string): Promise<boolean>;
  choose(contentType: string, now: number, limit?: number): Promise<any[]>;
  getStats(): Promise<any>;
  setBudget(soft: number, hard: number): Promise<void>;
  getAll(): Promise<any[]>;
}

export { L2EpisodicDO, L2Client };