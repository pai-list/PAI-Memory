/**
 * PAI-Memory L3 Facts/Semantic Core (in-memory kernel)
 *
 * Spec: docs/PAI-MEM-L3-SPEC.md §1–§7. Parent: docs/PAI-MEM-SPEC.md §3 (L3),
 * §4 numerics cascade, §5 power-law decay, §6 the clock decides, D2/D3/D4, D6.
 *
 * Milestone scope (light bitemporal envelope, flat-TS kernel):
 *   - Flat TS recall over the Matryoshka-256 first-pass, then f32 rescore on the
 *     k-candidate set (cascade rule: never serve quantized scores as final).
 *     NO HNSW/WASM until the M3 kill-rule benchmark (L3-SPEC §8) proves it wins.
 *   - Light bitemporal envelope: factKey + serial + validFrom/validTo(null=∞).
 *     Supersession by MAX serial; equal serial/time/window → surface (never
 *     silently collapse) — matches deterministic-resolver.ts tie rule.
 *   - INT8 per-dim ±1σ calibrated encoding; deterministic; clamp negative zero.
 *   - Power-law decay ret(t) = t^(−β), default β = 0.8 (spec L3 row).
 *   - D2 per-layer budget: soft 100 MiB / hard 500 MiB. Overflow → L3Overflow[]
 *     (promotion path — never silent truncation).
 *   - SAGE-style novelty write gate: ADD | NOOP | MERGE (deterministic cosine).
 */

import { MemoryLayer, MemoryTier } from './types';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const L3_SOFT_BUDGET_BYTES = 100 * 1024 * 1024; // D2: 100 MiB soft
export const L3_HARD_CEILING_BYTES = 500 * 1024 * 1024; // D2: 500 MiB hard ceiling
export const L3_MATRYOSHKA_DIM = 256; // §4.2 L3-sememe: Matryoshka-256
export const L3_DEFAULT_BETA = 0.8; // §3 L3 row: power-law β ≈ 0.8
export const L3_NOVELTY_UPSERT_LIMIT = 64; // novelty gate samples ≤ this many facts

/** Default per-content-type decay exponents (§5.1); mirrors the L2 table. */
export const L3_DECAY_BETA: Record<string, number> = {
  identity: 0.013, // near-zero decay (≳64k h half-life)
  commitment: 0.014,
  decision: 0.02,
  user_relevant: 0.04,
  generic: 0.8, // L3 default β
  rare: 1.5, // fast
};

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type L3OverflowReason = 'budget' | 'superseded' | 'expired';
export type NoveltyClass = 'ADD' | 'NOOP' | 'MERGE';

/** Per-dimension ±1σ calibration for INT8. */
export interface Int8Calibration {
  mean: Float32Array;
  scale: Float32Array;
}

/** INT8 quantized form (L3-warm). */
export interface Int8Quantization extends Int8Calibration {
  data: Int8Array;
}

/** DO configuration for L3. */
export interface L3DOConfig {
  softBudgetBytes?: number;
  hardCeilingBytes?: number;
}

/** JSON-safe INT8 slice carried by L3Overflow (crosses DO/worker boundary). */
export interface Int8Params {
  data: number[];
  mean: number[];
  scale: number[];
  dim: number;
}

export interface FactMetadata {
  contentType?: string;
  type?: 'fact' | 'procedure' | 'preference' | 'code' | 'context' | 'episodic';
  source?: string;
  agentId?: string;
  conversationId?: string;
  tags?: string[];
  confidence?: number;
  custom?: Record<string, unknown>;
}

/** A single L3 fact — light bitemporal envelope (§3.1). */
export interface FactRecord {
  id: string;
  factKey: string; // "agent:canonical_key" — same key = same fact
  content: string;
  serial: number; // monotonic issuer counter (not wall-clock)
  validFrom: number; // true-from (ms)
  validTo: number | null; // true-to (ms) | null = forever
  embedding: Float32Array; // f32 gold (L3-gold base)
  mat256: Float32Array; // Matryoshka-256 (L3-semiring first pass)
  int8: Int8Quantization; // INT8 ±1σ warm form
  metadata: FactMetadata;
  novelty: NoveltyClass;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  pinned: boolean; // right-of-user: never silently evicted
  layer: MemoryLayer;
  tier: MemoryTier;
}

/** Overflow object — shaped for M5 (L2→L3 promotion) now (spec §5). */
export interface L3Overflow {
  factKey: string;
  serial: number;
  embedding: Float32Array; // full f32, never truncated
  mat256: Float32Array; // truncated, re-insertable
  int8Params: Int8Params; // compressed warm form (+ calibration)
  reason: L3OverflowReason;
}

export interface RankedFact {
  fact: FactRecord;
  score: number; // f32 rescore — never INT8 (cascade rule)
  latencyMs: number;
}

export interface L3RecallOptions {
  validNow?: number; // "what is true at this instant"
  limit?: number; // top-k
  threshold?: number; // min f32 cosine to return
  rescoreK?: number; // candidate window for f32 rescore
}

export interface L3GraphConfig {
  softBudgetBytes?: number;
  hardCeilingBytes?: number;
  sizeBytesOf?: (f: FactRecord) => number;
  noveltyNear?: number; // cosine ≥ → NOOP
  noveltyMerge?: number; // ↓ cosine ≥ → MERGE; else ADD
  clock?: () => number;
}

export interface L3Stats {
  count: number;
  sizeBytes: number;
  softBudget: number;
  hardCeiling: number;
  pinnedCount: number;
  supersededCount: number;
  oldest: number | null;
  newest: number | null;
}

export interface DecayOptions {
  contentType?: string;
  importance?: number;
  accesses?: number;
  lastAccessMs?: number;
  now?: number;
  w1?: number;
  w2?: number;
  w3?: number;
  gamma?: number;
  tauMs?: number;
}

// ─────────────────────────────────────────────
// Numerics helpers (deterministic; clamp negative zero)
// ─────────────────────────────────────────────

export function clampNegZero(v: number): number {
  return v === 0 ? 0 : v;
}

/** Ties away from zero → deterministic across platforms. */
export function roundAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampInt8(x: number): number {
  if (x >= 127) return 127;
  if (x <= -127) return -127;
  return roundAwayFromZero(x);
}

/** Power-law §5.1: ret(t) = (h+1)^(−β), hours-based. */
export function powerDecay(ageMs: number, beta?: number): number {
  const hours = Math.max(0, ageMs) / 3_600_000;
  const b = beta ?? L3_DEFAULT_BETA;
  return Math.pow(hours + 1, -b);
}

/** §5.2 family score: arithmetic only — a clock, never an LLM. */
export function factScore(txnTimeMs: number, opts: DecayOptions = {}): number {
  const now = opts.now ?? Date.now();
  const age = Math.max(0, now - txnTimeMs);
  const contentType = opts.contentType ?? '';
  const beta = L3_DECAY_BETA[contentType] ?? L3_DEFAULT_BETA;
  const w1 = opts.w1 ?? 0.4;
  const w2 = opts.w2 ?? 0.35;
  const w3 = opts.w3 ?? 0.25;
  const gamma = opts.gamma ?? 0.5;
  const tau = opts.tauMs ?? 24 * 3_600_000;
  const power = Math.pow(age / 3_600_000 + 1, -beta);
  const accessBoost = Math.pow(1 + (opts.accesses ?? 0), gamma);
  const lastAccess = opts.lastAccessMs ?? txnTimeMs;
  const recency = Math.pow(0.5, Math.max(0, now - lastAccess) / tau);
  return clamp01(w1 * (opts.importance ?? 0) + w2 * power * accessBoost + w3 * recency);
}

/** Cosine similarity, deterministic, neg-zero clamped, 0 on zero-norm. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : clampNegZero(dot / norm);
}

/**
 * SAGE-style novelty gate (arithmetic-only):
 * - pool empty → ADD
 * - max cosine ≥ near → NOOP
 * - max cosine ≥ merge → MERGE
 * - else → ADD
 * Deterministic, no LLM involved.
 */
export function classifyNovelty(
  candidate: ReadonlyArray<number>,
  existing: ReadonlyArray<ReadonlyArray<number>>,
  opts: { near?: number; merge?: number } = {},
): NoveltyClass {
  const near = opts.near ?? 0.92;
  const merge = opts.merge ?? 0.8;
  let best = -Infinity;
  for (const cmp of existing) {
    const s = cosineSim(
      cmp instanceof Float32Array ? cmp : Float32Array.from(cmp),
      candidate instanceof Float32Array ? candidate : Float32Array.from(candidate),
    );
    if (s > best) best = s;
  }
  if (existing.length === 0 || best < merge) return 'ADD';
  if (best >= near) return 'NOOP';
  return 'MERGE';
}

/** Matryoshka truncate — first `dim` dims (cheap first pass). Deterministic. */
export function truncateMatryoshka(input: Float32Array | readonly number[], dim = L3_MATRYOSHKA_DIM): Float32Array {
  const out = new Float32Array(dim);
  const n = Math.min(dim, input.length);
  for (let i = 0; i < n; i++) out[i] = input[i];
  return out;
}

/**
 * INT8 quantize, per-dim ±1σ when a calibration is provided. Deterministic:
 *   q = clamp(roundAwayFromZero((x − mean)/scale) ∈ [−127,127])
 * Without calibration: per-vector zero-mean + max-abs scale (corpus-order
 * independent, reproducible).
 */
export function quantizeInt8(input: Float32Array, calibration?: Int8Calibration): Int8Quantization {
  const d = input.length;
  let maxAbs = 1;
  for (let i = 0; i < d; i++) {
    const a = Math.abs(input[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const data = new Int8Array(d);
  const mean = new Float32Array(d);
  const scale = new Float32Array(d);
  for (let i = 0; i < d; i++) {
    const m = calibration && calibration.mean.length === d ? calibration.mean[i] : 0;
    const s = calibration && calibration.scale.length === d ? calibration.scale[i] : maxAbs / 127;
    mean[i] = m;
    scale[i] = s === 0 ? 1 : s;
    data[i] = clampInt8((input[i] - m) / s);
  }
  return { data, mean, scale };
}

/** Dequant INT8 → f32 (audit/verification only — never served as scores). */
export function dequantizeInt8(q: Int8Quantization): Float32Array {
  const out = new Float32Array(q.data.length);
  for (let i = 0; i < q.data.length; i++) {
    out[i] = q.data[i] * q.scale[i] + q.mean[i];
  }
  return out;
}

/** Validity window: validFrom ≤ now AND (validTo null OR now ≤ validTo). */
export function validityActive(r: FactRecord, now: number): boolean {
  if (now < r.validFrom) return false;
  if (r.validTo !== null && now > r.validTo) return false;
  return true;
}

/** Flat row-major cosine matmul — the recall kernel measured by the M3 bench. */
export function flatMatmul(
  table: Float32Array,
  rows: number,
  dim: number,
  query: Float32Array | readonly number[],
  out: Float32Array,
): void {
  for (let i = 0; i < rows; i++) {
    const base = i * dim;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < dim; k++) {
      const x = table[base + k];
      const y = query[k];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    const norm = Math.sqrt(na) * Math.sqrt(nb);
    out[i] = norm === 0 ? 0 : clampNegZero(dot / norm);
  }
}

// ─────────────────────────────────────────────
// Default size estimator
// ─────────────────────────────────────────────

export function defaultL3SizeBytes(f: FactRecord): number {
  let bytes = new TextEncoder().encode(f.content ?? '').byteLength;
  bytes += f.embedding.byteLength; // f32 gold
  bytes += f.mat256.byteLength; // Matryoshka-256
  bytes += f.int8.data.byteLength + f.int8.mean.byteLength + f.int8.scale.byteLength;
  bytes += new TextEncoder().encode(f.factKey ?? '').byteLength;
  bytes += 128; // envelope overhead
  return bytes;
}

// ─────────────────────────────────────────────
// L3FactGraph — in-memory semantic fact graph
// ─────────────────────────────────────────────

export class L3FactGraph {
  readonly layer = 'L3_FACTS' as const;
  readonly tier = MemoryTier.COOL;

  private records = new Map<string, FactRecord>();
  private byKey = new Map<string, Map<string, FactRecord>>(); // factKey → id → record
  private serialCounter = new Map<string, number>(); // factKey → max serial seen

  private soft: number;
  private hard: number;
  private near: number;
  private merge: number;
  private readonly sizeOf: (f: FactRecord) => number;
  private clock: () => number;

  constructor(config: L3GraphConfig = {}) {
    const soft = config.softBudgetBytes ?? L3_SOFT_BUDGET_BYTES;
    this.soft = soft;
    this.hard = Math.max(config.hardCeilingBytes ?? L3_HARD_CEILING_BYTES, soft);
    this.near = config.noveltyNear ?? 0.92;
    this.merge = config.noveltyMerge ?? 0.8;
    this.sizeOf = config.sizeBytesOf ?? defaultL3SizeBytes;
    this.clock = config.clock ?? (() => Date.now());
  }

  // ── Introspection ──

  get count(): number {
    return this.records.size;
  }

  get sizeBytes(): number {
    let s = 0;
    for (const o of this.records.values()) s += this.sizeOf(o);
    return s;
  }

  get factKeyCount(): number {
    return this.byKey.size;
  }

  ids(): string[] {
    return [...this.records.keys()].sort();
  }

  // ── Reads ──

  get(id: string): FactRecord | null {
    const o = this.records.get(id);
    return o ? this.clone(o) : null;
  }

  /** Winning (max-serial, validity-active) record for a factKey at `now`. */
  resolve(factKey: string, now?: number): FactRecord | null {
    const t = now ?? this.clock();
    const bucket = this.byKey.get(factKey);
    if (!bucket) return null;
    let best: FactRecord | null = null;
    for (const o of bucket.values()) {
      if (!validityActive(o, t)) continue;
      if (!best || o.serial > best.serial) best = o;
    }
    return best ? this.clone(best) : null;
  }

  /** All serials for a factKey ascending (audit — superseded retained). */
  history(factKey: string): FactRecord[] {
    const bucket = this.byKey.get(factKey);
    if (!bucket) return [];
    return [...bucket.values()]
      .map((o) => this.clone(o))
      .sort((a, b) => a.serial - b.serial);
  }

  // ── Writes ──

  /**
   * Upsert a fact. Pipeline:
   *   1. normalize (truncate mat256, quantize INT8 when absent)
   *   2. SAGE novelty gate vs comparable facts
   *   3. supersession audit per factKey (every serial retained)
   *   4. budget enforcement → L3Overflow[] (no silent truncation)
   */
  upsert(o: FactRecord): L3Overflow[] {
    const stamp = this.clock();
    const full = this.normalize(o, stamp);
    full.novelty = this.classifyNovelty(full);

    const key = full.factKey;
    const bucket = this.byKey.get(key) ?? new Map<string, FactRecord>();
    bucket.set(full.id, full);
    this.byKey.set(key, bucket);
    this.serialCounter.set(key, Math.max(this.serialCounter.get(key) ?? 0, full.serial));

    this.records.set(full.id, full);
    return this.enforceBudget();
  }

  /** Convenience — build & store a fact from a raw embedding input. */
  store(input: {
    id: string;
    factKey: string;
    content?: string;
    embedding: Float32Array | readonly number[];
    serial?: number;
    validFrom?: number;
    validTo?: number | null;
    metadata?: FactMetadata;
    pinned?: boolean;
    importanceScore?: number;
  }): L3Overflow[] {
    const stamp = this.clock();
    const embed = toF32(input.embedding);
    return this.upsert({
      id: input.id,
      factKey: input.factKey,
      content: input.content ?? '',
      serial: input.serial ?? this.nextSerial(input.factKey),
      validFrom: input.validFrom ?? 0,
      validTo: input.validTo ?? null,
      embedding: embed,
      mat256: truncateMatryoshka(embed),
      int8: quantizeInt8(embed),
      metadata: input.metadata ?? {},
      novelty: 'ADD',
      createdAt: stamp,
      updatedAt: stamp,
      accessCount: 0,
      lastAccessedAt: stamp,
      importanceScore: input.importanceScore ?? 0,
      pinned: !!input.pinned,
      layer: MemoryLayer.L3_FACTS,
      tier: MemoryTier.COOL,
    });
  }

  /** D4: L3 forget requires humanConfirm (long-term facts = data loss). */
  forget(id: string, opts: { humanConfirm?: boolean } = {}): boolean {
    if (!opts.humanConfirm) return false;
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    const bucket = this.byKey.get(rec.factKey);
    bucket?.delete(rec.id);
    if (bucket && bucket.size === 0) this.byKey.delete(rec.factKey);
    return true;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const o = this.records.get(id);
    if (!o) return false;
    o.pinned = pinned;
    return true;
  }

  touch(id: string): boolean {
    const o = this.records.get(id);
    if (!o) return false;
    o.accessCount += 1;
    o.lastAccessedAt = this.clock();
    return true;
  }

  choose(contentType: string, now: number, limit = 100): Array<{ id: string; txnMs: number; score: number }> {
    const t = now ?? this.clock();
    return [...this.records.values()]
      .map((o) => ({
        id: o.id,
        txnMs: o.createdAt,
        score: factScore(o.createdAt, {
          contentType: contentType ?? o.metadata.contentType,
          importance: o.importanceScore,
          accesses: o.accessCount,
          lastAccessMs: o.lastAccessedAt,
          now: t,
        }),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Recall cascade: Matryoshka-256 first pass builds candidates, then f32 exact
   * rescore on the k-candidate window (cascade rule — quantized never final).
   * Honors supersession: per factKey, only the MAX serial within the valid window
   * is considered (the clock decides — never an LLM).
   */
  recall(q: Float32Array | readonly number[], opts: L3RecallOptions = {}): RankedFact[] {
    const start = performanceNow();
    const now = opts.validNow ?? this.clock();
    const queryFull = toF32(q);
    const queryMat = truncateMatryoshka(queryFull);
    const limit = opts.limit ?? 10;
    const rescoreK = opts.rescoreK ?? Math.max(limit * 8, 64);
    const threshold = opts.threshold ?? 0;

    // First pass: collect valid records, then supersession filter per factKey
    const byKey = new Map<string, FactRecord>();
    for (const o of this.records.values()) {
      if (!validityActive(o, now)) continue;
      const existing = byKey.get(o.factKey);
      if (!existing || o.serial > existing.serial) {
        byKey.set(o.factKey, o);
      }
    }

    const candidates: Array<{ r: FactRecord; s: number }> = [];
    for (const o of byKey.values()) {
      const s = cosineSim(queryMat, o.mat256);
      candidates.push({ r: o, s });
    }
    candidates.sort((a, b) => b.s - a.s);
    const top = candidates.slice(0, Math.min(rescoreK, candidates.length));

    return top
      .map(({ r }) => ({ r, s: cosineSim(queryFull, r.embedding) }))
      .filter((x) => x.s >= threshold)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ r, s }) => ({ fact: this.clone(r), score: s, latencyMs: performanceNow() - start }));
  }

  export(): FactRecord[] {
    return [...this.records.values()].map((o) => this.clone(o));
  }

  import(recs: FactRecord[]): number {
    let n = 0;
    for (const r of recs) {
      this.upsert(r);
      n++;
    }
    return n;
  }

  getStats(): L3Stats {
    let pinned = 0;
    let superseded = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const o of this.records.values()) {
      if (o.pinned) pinned++;
      if (this.isSuperseded(o)) superseded++;
      if (o.createdAt < (oldest ?? Infinity)) oldest = o.createdAt;
      if (o.createdAt > (newest ?? -Infinity)) newest = o.createdAt;
    }
    return {
      count: this.count,
      sizeBytes: this.sizeBytes,
      softBudget: this.soft,
      hardCeiling: this.hard,
      pinnedCount: pinned,
      supersededCount: superseded,
      oldest,
      newest,
    };
  }

  setBudget(soft: number, hard: number): void {
    this.soft = soft;
    this.hard = Math.max(hard, soft);
    this.enforceBudget();
  }

  // ── Private ──

  private normalize(o: FactRecord, stamp: number): FactRecord {
    const embed = toF32(o.embedding);
    return {
      ...o,
      embedding: embed,
      mat256: truncateMatryoshka(embed),
      int8: o.int8 && o.int8.data.length === embed.length ? o.int8 : quantizeInt8(embed),
      createdAt: o.createdAt ?? stamp,
      updatedAt: o.updatedAt ?? stamp,
      accessCount: o.accessCount ?? 0,
      lastAccessedAt: o.lastAccessedAt ?? stamp,
      importanceScore: o.importanceScore ?? 0,
      pinned: !!o.pinned,
    };
  }

  private classifyNovelty(o: FactRecord): NoveltyClass {
    let best = -Infinity;
    const pool = [...this.records.values()].slice(0, L3_NOVELTY_UPSERT_LIMIT);
    for (const other of pool) {
      const s = cosineSim(o.mat256, other.mat256);
      if (s > best) best = s;
    }
    if (pool.length === 0) return 'ADD';
    if (best >= this.near) return 'NOOP';
    if (best >= this.merge) return 'MERGE';
    return 'ADD';
  }

  private nextSerial(factKey: string): number {
    const next = (this.serialCounter.get(factKey) ?? 0) + 1;
    this.serialCounter.set(factKey, next);
    return next;
  }

  private isSuperseded(o: FactRecord): boolean {
    const bucket = this.byKey.get(o.factKey);
    if (!bucket) return false;
    for (const other of bucket.values()) {
      if (other.serial > o.serial) return true;
    }
    return false;
  }

  private enforceBudget(): L3Overflow[] {
    const overflows: L3Overflow[] = [];
    let over = this.sizeBytes - this.soft;
    if (over <= 0) return overflows;

    let guard = 0;
    while (this.sizeBytes > this.hard || (over > 0 && guard < 64)) {
      const evictable = [...this.records.values()]
        .filter((f) => !f.pinned)
        .sort((a, b) => a.createdAt - b.createdAt);
      const oldest = evictable[0];
      if (!oldest) break; // all pinned — right-of-user wins
      overflows.push(this.toOverflow(oldest, this.overflowReason(oldest)));
      this.records.delete(oldest.id);
      const bucket = this.byKey.get(oldest.factKey);
      bucket?.delete(oldest.id);
      guard++;
      over = this.sizeBytes - this.soft;
    }
    return overflows;
  }

  private overflowReason(o: FactRecord): L3OverflowReason {
    const now = this.clock();
    if (o.validTo !== null && now > o.validTo) return 'expired';
    if (this.isSuperseded(o)) return 'superseded';
    return 'budget';
  }

  private toOverflow(f: FactRecord, reason: L3OverflowReason): L3Overflow {
    return {
      factKey: f.factKey,
      serial: f.serial,
      embedding: f.embedding.slice(),
      mat256: f.mat256.slice(),
      int8Params: toInt8Params(f.int8),
      reason,
    };
  }

  private clone(o: FactRecord): FactRecord {
    return {
      ...o,
      embedding: o.embedding.slice(),
      mat256: o.mat256.slice(),
      int8: { data: o.int8.data.slice(), mean: o.int8.mean.slice(), scale: o.int8.scale.slice() },
      metadata: o.metadata ? { ...o.metadata } : {},
    };
  }
}

// ── Free helpers shared with the DO layer ──

export function toInt8Params(q: Int8Quantization): Int8Params {
  return {
    data: Array.from(q.data),
    mean: Array.from(q.mean),
    scale: Array.from(q.scale),
    dim: q.data.length,
  };
}

export function fromInt8Params(p: Int8Params): Int8Quantization {
  return {
    data: Int8Array.from(p.data),
    mean: Float32Array.from(p.mean),
    scale: Float32Array.from(p.scale),
  };
}

function toF32(a: Float32Array | readonly number[]): Float32Array {
  return a instanceof Float32Array ? a : Float32Array.from(a);
}

function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}