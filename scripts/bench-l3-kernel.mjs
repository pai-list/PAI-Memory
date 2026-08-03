#!/usr/bin/env node
/**
 * L3 Kill-Rule Kernel Benchmark
 * Micro-benchmarks the cosineSim kernel and mathematically extrapolates to N=10k/50k/100k.
 * Runs as raw Node script — no vitest, no timeouts.
 */

import { performance } from 'perf_hooks';
import { writeFileSync } from 'fs';

// Simple deterministic PRNG for vectors
function makeVector(dim, seed) {
  const v = new Float32Array(dim);
  let x = seed + 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return v;
}

// Pure cosine similarity (matches l3-facts-semantic.ts)
function cosineSim(a, b) {
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
  return norm === 0 ? 0 : dot / norm;
}

// Benchmark the kernel
function benchKernel(dim, iters = 100000) {
  const a = makeVector(dim, 1);
  const b = makeVector(dim, 2);
  
  // Warmup
  for (let i = 0; i < 1000; i++) cosineSim(a, b);
  
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) cosineSim(a, b);
  const t1 = performance.now();
  
  return (t1 - t0) / iters; // ms per cosine
}

// Extrapolate full recall time
function extrapolateRecall(N, tCosine, overheadMs = 0.5) {
  // First pass: N * T_cosine (mat256)
  // Rescore: k * T_cosine_f32 (k=64, f32 cosine is similar speed)
  // Overhead: validity filtering, sorting, etc.
  return N * tCosine + 64 * tCosine + overheadMs;
}

// Run benchmarks
console.log('=== L3 Kill-Rule Kernel Benchmark ===\n');

const results = [];

for (const dim of [256, 768, 1024]) {
  const tCosine = benchKernel(dim);
  console.log(`cosineSim(d=${dim}): ${tCosine.toFixed(4)}ms per call`);
  
  for (const N of [10000, 50000, 100000]) {
    const tRecall = extrapolateRecall(N, tCosine);
    console.log(`  N=${N.toLocaleString().padStart(6)}: ~${tRecall.toFixed(2)}ms extrapolated`);
    
    // Kill-rule gate at N=10k, d=256
    if (dim === 256 && N === 10000) {
      const gate = tRecall < 5 ? 'PASS (SKIP WASM)' : 
                   tRecall < 20 ? 'PROFILE (I/O vs CPU?)' : 'FAIL -> M4 WASM HNSW';
      console.log(`  -> KILL-RULE GATE: ${gate}`);
    }
    
    results.push({ dim, N, tCosine, tRecall });
  }
  console.log();
}

console.log('Results written to bench/l3-kill-rule-results.json');
writeFileSync('bench/l3-kill-rule-results.json', JSON.stringify({ 
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  results 
}, null, 2));