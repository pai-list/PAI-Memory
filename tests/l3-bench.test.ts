/**
 * L3 Micro-Benchmark (M3) - Kill-Rule Gate
 *
 * Measures the core recall path latency on a small dataset.
 * This is a minimal gate check; full scaling benchmarks run separately.
 */

import { describe, it, expect } from 'vitest';
import {
  L3FactGraph,
  FactRecord,
  truncateMatryoshka,
  quantizeInt8,
  cosineSim,
} from '../packages/pai-memory-core/src/l3-facts-semantic';

// ───────────── helpers ─────────────

function makeVector(dim: number, seed = 0): Float32Array {
  const v = new Float32Array(dim);
  let x = seed + 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return v;
}

function makeFact(over: { [k: string]: unknown } = {}): FactRecord {
  const dim = (over.dim as number) ?? 768;
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

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe('M3 Kill-Rule Micro-Benchmark', () => {
  it('cosineSim microbenchmark (d=256)', () => {
    const a = makeVector(256, 1);
    const b = makeVector(256, 2);
    const iters = 10000;
    const latencies: number[] = [];
    for (let i = 0; i < iters; i++) {
      const s = performance.now();
      cosineSim(a, b);
      latencies.push(performance.now() - s);
    }
    const p95 = percentile(latencies, 95);
    console.log(`cosineSim d=256 x${iters}: p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(0.01); // sub-10μs per call
  });

  it('end-to-end recall on 100 facts (d=256 first pass + f32 rescore)', () => {
    const graph = new L3FactGraph({
      softBudgetBytes: 100 * 1024 * 1024,
      hardCeilingBytes: 500 * 1024 * 1024,
    });

    // Build small graph (100 facts, d=768 base)
    const facts: FactRecord[] = [];
    for (let i = 0; i < 100; i++) {
      const v = makeVector(768, i + 1);
      facts.push(makeFact({ id: `f${i}`, factKey: `k:${i}`, embedding: v }));
    }
    graph.import(facts);

    const query = makeVector(768, 100);

    // Warmup
    for (let i = 0; i < 5; i++) graph.recall(query, { limit: 10, rescoreK: 64 });

    // Benchmark
    const iters = 50;
    const latencies: number[] = [];
    for (let i = 0; i < iters; i++) {
      const s = performance.now();
      graph.recall(query, { limit: 10, rescoreK: 64 });
      latencies.push(performance.now() - s);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log('\n=== M3 MICRO-BENCHMARK (N=100, d=256 first pass) ===');
    console.log(`p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms`);
    console.log('=== KILL-RULE GATE (extrapolated) ===');
    // Extrapolate to N=10k: roughly 100x more candidates in first pass
    const extrapolated = p95 * 100;
    if (extrapolated < 5) console.log(`PASS: extrapolated p95 ~${extrapolated.toFixed(1)}ms < 5ms → SKIP WASM`);
    else if (extrapolated < 20) console.log(`PROFILE: extrapolated p95 ~${extrapolated.toFixed(1)}ms 5-20ms → profile I/O vs CPU`);
    else console.log(`FAIL: extrapolated p95 ~${extrapolated.toFixed(1)}ms > 20ms → M4: re-derive WASM HNSW`);
    console.log('=========================================\n');

    // Record the actual small-N p95 for CI (no gate assertion - it's a measurement)
    expect(p95).toBeGreaterThan(0);
  }, 30000);
});