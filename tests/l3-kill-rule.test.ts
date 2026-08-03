import { describe, it, expect } from 'vitest';
import resultsData from '../bench/l3-kill-rule-results.json';

describe('M3 Kill-Rule Gate (from kernel benchmark model)', () => {
  const { results, platform, arch, timestamp } = resultsData;

  it('records kernel benchmark metadata', () => {
    expect(platform).toBe('darwin');
    expect(arch).toBe('x64');
    expect(new Date(timestamp).getTime()).toBeGreaterThan(0);
  });

  it('evaluates kill-rule gate at N=10k, d=256 (Matryoshka first pass)', () => {
    const gateEntry = results.find(r => r.dim === 256 && r.N === 10000);
    expect(gateEntry).toBeDefined();
    
    const tRecall = gateEntry.tRecall;
    console.log(`\nM3 Kill-Rule Gate (kernel model):`);
    console.log(`  N=10k, d=256 extrapolated recall: ${tRecall.toFixed(2)}ms`);
    
    let gate;
    if (tRecall < 5) gate = 'PASS (SKIP WASM)';
    else if (tRecall < 20) gate = 'PROFILE (I/O vs CPU?)';
    else gate = 'FAIL -> M4 WASM HNSW';
    
    console.log(`  GATE: ${gate}`);
    console.log(`  Kernel tCosine: ${gateEntry.tCosine.toFixed(4)}ms\n`);
    
    // Record the gate - this IS the M3 decision
    expect(gateEntry.tRecall).toBeGreaterThan(0);
    expect(['PASS (SKIP WASM)', 'PROFILE (I/O vs CPU?)', 'FAIL -> M4 WASM HNSW']).toContain(gate);
  });

  it('provides scaling curve for d=256', () => {
    const scaling = results.filter(r => r.dim === 256).map(r => ({ N: r.N, tRecall: r.tRecall }));
    console.log('\nScaling curve (d=256 Matryoshka first pass):');
    scaling.forEach(s => console.log(`  N=${s.N.toLocaleString().padStart(6)}: ~${s.tRecall.toFixed(1)}ms`));
    expect(scaling.length).toBe(3);
  });
});