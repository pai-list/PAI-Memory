/**
 * L3 Kill-Rule Benchmark (M3)
 *
 * Measures end-to-end recall latency inside the DO environment.
 * Tests at 10k, 50k, 100k vectors (d=256 Matryoshka first pass + f32 rescore).
 *
 * Kill-Rule Decision Matrix:
 *   N=10k, d=256 < 5ms   → SKIP WASM, ship flat
 *   N=10k, d=256 5-20ms  → Profile first (I/O vs CPU bound?)
 *   N=10k, d=256 > 20ms  → M4: re-derived WASM HNSW
 *
 * Scaling curve: if 10k ≤ 5ms but 50k > 35ms → WASM inevitable, schedule M4.
 */

import { describe, it, expect } from 'vitest';
import {
  L3FactGraph,
  FactRecord,
  L3_MATRYOSHKA_DIM,
  truncateMatryoshka,
  quantizeInt8,
  makeVector,
  cosineSim,
} from '../packages/pai-memory-core/src/l3-facts-semantic';
import { MemoryLayer, MemoryTier } from '../packages/pai-memory-core/src/types';

// ───────────── helpers ─────────────

function makeFact(over: { [k: string]: unknown } = {}): FactRecord {
  const dim = (over.dim as number) ?? 768; // base embedding dim
  const embed = over.embedding ? Float32Array.from(over.embedding as number[]) : makeVector(dim);
  const id = (over.id as string) ?? `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    metadata: (over.metadata as FactRecord['metadata']) ?? { contentType: 'generic', confidence: 1 },
    novelty: (over.novelty as FactRecord['novelty']) ?? 'ADD',
    createdAt: (over.createdAt as number) ?? Date.now(),
    updatedAt: (over.updatedAt as number) ?? Date.now(),
    accessCount: (over.accessCount as number) ?? 0,
    lastAccessedAt: (over.lastAccessedAt as number) ?? Date.now(),
    importanceScore: (over.importanceScore as number) ?? 0,
    pinned: (over.pinned as boolean) ?? false,
  };
}

// ───────────── benchmark ─────────────

interface BenchResult {
  N: number;
  dim: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function runRecallBench(graph: L3FactGraph, queryEmb: Float32Array, iterations: number): number[] {
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    graph.recall(queryEmb, { limit: 10, rescoreK: 64 });
    latencies.push(performance.now() - start);
  }
  return latencies;
}

function buildGraph(N: number, baseDim = 768): { graph: L3FactGraph; query: Float32Array } {
  const graph = new L3FactGraph({
    softBudgetBytes: 2 * 1024 * 1024 * 1024, // 2GB - no budget pressure
    hardCeilingBytes: 4 * 1024 * 1024 * 1024,
  });

  // Generate N facts with deterministic vectors
  const facts: FactRecord[] = [];
  for (let i = 0; i < N; i++) {
    // Use seed based on i for reproducibility
    const dim = baseDim;
    const v = new Float32Array(dim);
    let x = i + 1;
    for (let k = 0; k < dim; k++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      v[k] = (x / 0x7fffffff) * 2 - 1;
    }
    facts.push(makeFact({ id: `f${i}`, factKey: `k:${i}`, embedding: v }));
  }
  graph.import(facts);

  // Query vector similar to fact 0 (for meaningful recall)
  const query = new Float32Array(baseDim);
  let x = 1;
  for (let k = 0; k < baseDim; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    query[k] = (x / 0x7fffffff) * 2 - 1;
  }

  return { graph, query };
}

function benchPoint(N: number, dim = 768): BenchResult {
  const { graph, query } = buildGraph(N, dim);

  // Warmup
  for (let i = 0; i < 5; i++) graph.recall(query, { limit: 10, rescoreK: 64 });

  const iterations = N >= 50000 ? 20 : 50;
  const latencies = runRecallBench(graph, query, iterations);

  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    N,
    dim,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
    mean: sum / latencies.length,
  };
}

function formatResult(r: BenchResult): string {
  return `N=${r.N.toLocaleString().padStart(6)}  p50=${r.p50.toFixed(2).padStart(6)}ms  p95=${r.p95.toFixed(2).padStart(6)}ms  p99=${r.p99.toFixed(2).padStart(6)}ms  mean=${r.mean.toFixed(2)}ms`;
}

// ───────────── test / benchmark ─────────────

describe('M3 Kill-Rule Benchmark', () => {
  it('bench N=10k (d=256 Matryoshka first pass + f32 rescore)', () => {
    const r = benchPoint(10_000, 256);
    console.log('\n=== M3 BENCHMARK RESULTS ===');
    console.log('dim=256 (Matryoshka first pass)');
    console.log(formatResult(r));
    console.log('=== KILL-RULE GATE ===');
    const p95 = r.p95;
    if (p95 < 5) console.log('✅ PASS: p95 < 5ms → SKIP WASM, ship flat');
    else if (p95 < 20) console.log('⚠️  PROFILE: p95 5-20ms → profile I/O vs CPU');
    else console.log('🚨 FAIL: p95 > 20ms → M4: re-derive WASM HNSW');
    console.log('=========================\n');

    // Gate assertion: record the p95 for CI visibility
    expect(r.p95).toBeLessThan(100); // generous upper bound for CI
  });

  it('bench N=50k (scaling curve)', () => {
    const r = benchPoint(50_000, 256);
    console.log(formatResult(r));
    expect(r.p95).toBeLessThan(200);
  });

  it('bench N=100k (stress test)', () => {
    const r = benchPoint(100_000, 256);
    console.log(formatResult(r));
    expect(r.p95).toBeLessThan(500);
  });

  it('bench N=10k full dim=768 (cascade full path)', () => {
    const r = benchPoint(10_000, 768);
    console.log(`dim=768 (full f32 rescore): ${formatResult(r)}`);
    expect(r.p95).toBeLessThan(200);
  });

  it('bench N=10k full dim=1024 (max cascade)', () => {
    const r = benchPoint(10_000, 1024);
    console.log(`dim=1024 (bge-m3): ${formatResult(r)}`);
    expect(r.p95).toBeLessThan(300);
  });
});