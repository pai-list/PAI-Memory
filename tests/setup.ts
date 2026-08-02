// Vitest global setup for @pai/memory.
// Cloudflare-bindings mocking helpers live here so all suites share them.

import { vi } from 'vitest';

/** Build a mock Cloudflare DurableObject state (io-bound members). */
export function mockDurableObjectCtx(overrides: Record<string, unknown> = {}) {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    blockConcurrencyWhile: vi.fn((fn: () => unknown) => fn()),
    id: { toString: () => 'test-id' },
    ...overrides,
  };
}

/** Build a mock worker Env with the bindings MemoryRouter consumes. */
export function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}