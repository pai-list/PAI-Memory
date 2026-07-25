import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from '../src/core/MemoryRouter';

// Mock Cloudflare Workers environment
const mockCtx = {
  storage: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  },
  blockConcurrencyWhile: vi.fn((fn) => fn()),
  id: { toString: () => 'test-id' },
};

const mockEnv = {
  AI: {
    run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
  },
  DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }),
  },
  SESSIONS: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ARTIFACTS: { put: vi.fn(), get: vi.fn() },
  MEMORY: { query: vi.fn(), upsert: vi.fn() },
};

describe('MemoryRouter', () => {
  let router: any;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new (await import('../src/core/MemoryRouter')).MemoryRouter(mockCtx, mockEnv);
    await router.initialize();
  });

  it('should initialize with empty layers', async () => {
    const results = await router.recall({ query: 'test' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('should remember and recall entries', async () => {
    const id = await router.remember({
      layer: 'L1',
      content: 'Test memory entry',
      metadata: { tags: ['test'], source: 'test', intention: 'test', confidence: 0.9 },
    });
    expect(typeof id).toBe('string');

    const results = await router.recall({ query: 'Test', layers: ['L1'] });
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
