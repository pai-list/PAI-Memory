import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from '../src/core/MemoryRouter';
import { mockDurableObjectCtx, mockEnv } from './setup';

describe('MemoryRouter', () => {
  let router: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const ctx = mockDurableObjectCtx();
    const env = mockEnv();
    // Constructor already runs blockConcurrencyWhile → initializes layers map.
    router = new MemoryRouter(ctx, env);
  });

  it('should initialize with empty layers', async () => {
    const results = await router.recall({ query: 'test' });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it('should remember and recall entries', async () => {
    const id = await router.remember({
      layer: 'L1',
      content: 'Test memory entry',
      metadata: { tags: ['test'], source: 'test', intention: 'test', confidence: 0.9 },
    });
    expect(typeof id).toBe('string');

    const results = await router.recall({ query: 'Test', layers: ['L1'] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.content).toBe('Test memory entry');
  });

  it('should not recall across layers it does not contain', async () => {
    const id = await router.remember({
      layer: 'L3',
      content: 'vectorized fact about tennis',
      metadata: { tags: ['sport'], source: 'agent', intention: 'store', confidence: 0.9 },
    });
    expect(typeof id).toBe('string');

    // L1/L2 queries must not return an L3-only memory by text match alone.
    const l1results = await router.recall({ query: 'tennis', layers: ['L1', 'L2'] });
    expect(l1results).toHaveLength(0);
  });
});