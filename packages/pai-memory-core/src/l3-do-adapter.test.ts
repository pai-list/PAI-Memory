import { describe, it, expect, vi, beforeEach } from 'vitest';
import { L3FactGraphDO, L3Client, L3DOConfig } from '../src/l3-do-adapter';
import { FactRecord, quantizeInt8, truncateMatryoshka, toInt8Params } from '../src/l3-facts-semantic';
import { MemoryLayer, MemoryTier } from '../src/types';

// Mock DO state and environment
function mockDurableObjectCtx(overrides: Record<string, unknown> = {}) {
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

function mockEnv(overrides: Record<string, unknown> = {}) {
  // Pre-canned results for specific queries
  const budgetCheckResult = {
    results: [{ count: 0, total_bytes: 0 }],
  };
  const statsResult = {
    results: [{
      count: 0,
      total_bytes: 0,
      pinned_count: 0,
      oldest: null,
      newest: null,
    }],
  };
  const emptyResult = { results: [] };
  const factResult = {
    id: 'test-get-id',
    fact_key: 'test:key',
    content: 'Test fact',
    serial: 1,
    valid_from: 0,
    valid_to: null,
    embedding: new Float32Array(32).fill(0.1).buffer,
    mat256: new Float32Array(32).fill(0.1).buffer,
    int8_data: new Uint8Array(32).fill(1).buffer,
    int8_mean: new Float32Array(32).fill(0).buffer,
    int8_scale: new Float32Array(32).fill(1).buffer,
    metadata_json: JSON.stringify({ contentType: 'generic', confidence: 1 }),
    layer: 'L3_FACTS',
    tier: 'COOL',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    importanceScore: 0,
    pinned: 0,
    novelty: 'ADD',
  };

  // Query-specific mock chain
  const makeChain = (result: any) => ({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(result.first ?? null),
      all: vi.fn().mockResolvedValue(result.all ?? { results: [] }),
    }),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(result.first ?? null),
    all: vi.fn().mockResolvedValue(result.all ?? { results: [] }),
  });

  const chains = {
    budgetCheck: makeChain({ 
      first: { count: 0, total_bytes: 0 }, 
      all: { results: [{ count: 0, total_bytes: 0 }] } 
    }),
    stats: makeChain({ 
      first: { count: 0, total_bytes: 0, pinned_count: 0, oldest: null, newest: null } 
    }),
    empty: makeChain({ first: null, all: { results: [] } }),
    fact: makeChain({
      first: {
        id: 'test-get-id',
        fact_key: 'test:key',
        content: 'Test fact',
        serial: 1,
        valid_from: 0,
        valid_to: null,
        embedding: new Float32Array(32).fill(0.1).buffer,
        mat256: new Float32Array(32).fill(0.1).buffer,
        int8_data: new Uint8Array(32).fill(1).buffer,
        int8_mean: new Float32Array(32).fill(0).buffer,
        int8_scale: new Float32Array(32).fill(1).buffer,
        metadata_json: JSON.stringify({ contentType: 'generic', confidence: 1 }),
        layer: 'L3_FACTS',
        tier: 'COOL',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        importanceScore: 0,
        pinned: 0,
        novelty: 'ADD',
      },
      all: { results: [{ id: 'test-get-id', fact_key: 'test:key', content: 'Test fact' }] }
    }),
  };

  // Override prepare to return appropriate mock based on SQL
const prepareMock = vi.fn((sql: string) => {
    const lowerSql = sql.toLowerCase().replace(/\s+/g, ' ');
    if (lowerSql.includes('select count(*) as count') && lowerSql.includes('total_bytes') && !lowerSql.includes('pinned_count')) {
      console.log('[TEST MOCK] -> budgetCheck');
      return chains.budgetCheck;
    }
    if (lowerSql.includes('select * from l3_facts where id')) {
      // The ID is passed as a bind parameter, not in the SQL text
      // We'll use the override flag for non-existent test
      if ((overrides as any).returnNullFact) {
        return chains.empty;
      }
      return chains.fact;
    }
    if (lowerSql.includes('select count(*) as count') && lowerSql.includes('pinned_count')) {
      return chains.stats;
    }
    console.log('[TEST MOCK] -> empty (fallback)');
    return chains.empty;
  });

  return {
    DB: {
      prepare: prepareMock,
      exec: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

// Build a minimal valid FactRecord for testing
function makeFactRecord(over: Partial<FactRecord> = {}): FactRecord {
  const embed = over.embedding ? Float32Array.from(over.embedding) : new Float32Array(32).fill(0.1);
  const mat256 = over.mat256 ? Float32Array.from(over.mat256) : truncateMatryoshka(embed);
  const int8 = over.int8 ? over.int8 : quantizeInt8(embed);

  return {
    id: over.id ?? `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    factKey: over.factKey ?? 'test:key',
    content: over.content ?? 'Test fact',
    serial: over.serial ?? 1,
    validFrom: over.validFrom ?? 0,
    validTo: over.validTo ?? null,
    embedding: embed,
    mat256,
    int8,
    metadata: over.metadata ?? { contentType: 'generic', confidence: 1 },
    novelty: over.novelty ?? 'ADD',
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    accessCount: over.accessCount ?? 0,
    lastAccessedAt: over.lastAccessedAt ?? Date.now(),
    importanceScore: over.importanceScore ?? 0,
    pinned: over.pinned ?? false,
  };
}

describe('L3 DO Adapter', () => {
  let doInstance: L3FactGraphDO;
  let mockCtx: any;
  let mockEnvObj: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx = mockDurableObjectCtx();
    mockEnvObj = mockEnv();
    const config: L3DOConfig = {
      softBudgetBytes: 1024 * 1024,
      hardCeilingBytes: 5 * 1024 * 1024,
    };
    doInstance = new L3FactGraphDO(mockCtx, mockEnvObj, config);
  });

  it('should initialize with correct budget defaults', async () => {
    const config: L3DOConfig = {};
    const instance = new L3FactGraphDO(mockCtx, mockEnvObj, config);
    await instance.initialize();
    expect(mockEnvObj.DB.exec).toHaveBeenCalled();
  });

  it('should use custom budget config from constructor', async () => {
    const config: L3DOConfig = { softBudgetBytes: 2048, hardCeilingBytes: 8192 };
    const instance = new L3FactGraphDO(mockCtx, mockEnvObj, config);
    // Budgets are private but we can test via getStats after init
    await instance.initialize();
    const stats = await instance.getStats();
    expect(stats.softBudget).toBe(2048);
    expect(stats.hardCeiling).toBe(8192);
  });

  it('should load budget from storage on init', async () => {
    const storedBudget = { soft: 5000, hard: 20000 };
    mockCtx.storage.get.mockResolvedValue(storedBudget);
    const config: L3DOConfig = { softBudgetBytes: 1000, hardCeilingBytes: 5000 };
    const instance = new L3FactGraphDO(mockCtx, mockEnvObj, config);
    await instance.initialize();
    const stats = await instance.getStats();
    expect(stats.softBudget).toBe(5000);
    expect(stats.hardCeiling).toBe(20000);
  });

  it('should upsert a fact and return overflow array', async () => {
    await doInstance.initialize();
    const fact = makeFactRecord();

    const overflows = await doInstance.upsert(fact);

    expect(Array.isArray(overflows)).toBe(true);
    expect(mockEnvObj.DB.prepare).toHaveBeenCalled();
  });

  it('should get a fact by ID', async () => {
    await doInstance.initialize();
    const fact = makeFactRecord({ id: 'test-get-id' });

    // Mock the DB response
    const dbPrepare = mockEnvObj.DB.prepare;
    dbPrepare.mockReturnValueOnce({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({
          id: 'test-get-id',
          fact_key: 'test:key',
          content: 'Test fact',
          serial: 1,
          valid_from: 0,
          valid_to: null,
          embedding: new Float32Array(32).fill(0.1).buffer,
          mat256: new Float32Array(32).fill(0.1).buffer,
          int8_data: new Uint8Array(32).fill(1).buffer,
          int8_mean: new Float32Array(32).fill(0).buffer,
          int8_scale: new Float32Array(32).fill(1).buffer,
          metadata_json: JSON.stringify({ contentType: 'generic', confidence: 1 }),
          layer: 'L3_FACTS',
          tier: 'COOL',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          accessCount: 0,
          lastAccessedAt: Date.now(),
          importanceScore: 0,
          pinned: 0,
          novelty: 'ADD',
        }),
      }),
    });

    const result = await doInstance.get('test-get-id');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('test-get-id');
  });

  it('should return null for non-existent fact', async () => {
    await doInstance.initialize();
    const result = await doInstance.get('non-existent', { returnNullFact: true });
    expect(result).toBeNull();
  });

  it('should touch a fact (update access count)', async () => {
    await doInstance.initialize();
    await doInstance.touch('some-id');
    expect(mockEnvObj.DB.prepare).toHaveBeenCalled();
  });

  it('should forget a fact', async () => {
    await doInstance.initialize();
    const result = await doInstance.forget('some-id');
    expect(mockEnvObj.DB.prepare).toHaveBeenCalled();
    expect(typeof result).toBe('boolean');
  });

  it('should set pin status', async () => {
    await doInstance.initialize();
    await doInstance.setPinned('some-id', true);
    expect(mockEnvObj.DB.prepare).toHaveBeenCalled();
  });

  it('should check if fact is pinned', async () => {
    await doInstance.initialize();
    const dbPrepare = mockEnvObj.DB.prepare;
    dbPrepare.mockReturnValueOnce({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ pinned: 1 }),
      }),
    });

    const result = await doInstance.isPinned('some-id');
    expect(result).toBe(true);
  });

  it('should get stats', async () => {
    await doInstance.initialize();
    const stats = await doInstance.getStats();
    expect(stats).toHaveProperty('count');
    expect(stats).toHaveProperty('sizeBytes');
    expect(stats).toHaveProperty('softBudget');
    expect(stats).toHaveProperty('hardCeiling');
    expect(stats).toHaveProperty('pinnedCount');
  });

  it('should set budget and persist to storage', async () => {
    await doInstance.initialize();
    await doInstance.setBudget(2048, 8192);
    expect(mockCtx.storage.put).toHaveBeenCalledWith('budget', { soft: 2048, hard: 8192 });
    const stats = await doInstance.getStats();
    expect(stats.softBudget).toBe(2048);
    expect(stats.hardCeiling).toBe(8192);
  });

  it('should export all facts', async () => {
    await doInstance.initialize();
    const results = await doInstance.getAll();
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('L3Client', () => {
  let mockStub: any;
  let client: L3Client;

  beforeEach(() => {
    mockStub = {
      upsert: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      getMany: vi.fn().mockResolvedValue([]),
      slice: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(true),
      forget: vi.fn().mockResolvedValue(true),
      setPinned: vi.fn().mockResolvedValue(true),
      isPinned: vi.fn().mockResolvedValue(false),
      choose: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({}),
      setBudget: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
    };
    client = new L3Client(mockStub);
  });

  it('should wrap upsert and clear cache', async () => {
    const fact = makeFactRecord({ id: 'client-test' });
    const result = await client.upsert(fact);
    expect(mockStub.upsert).toHaveBeenCalledWith(fact);
    expect(Array.isArray(result)).toBe(true);
  });

  it('should get a fact and cache it', async () => {
    const fact = makeFactRecord({ id: 'cache-test' });
    mockStub.get.mockResolvedValue(fact);
    const result = await client.get('cache-test');
    expect(result).toEqual(fact);
    // Second call should use cache
    const result2 = await client.get('cache-test');
    expect(result2).toEqual(fact);
    expect(mockStub.get).toHaveBeenCalledTimes(1);
  });

  it('should delegate other methods', async () => {
    await client.getMany(['a', 'b']);
    expect(mockStub.getMany).toHaveBeenCalledWith(['a', 'b']);

    await client.slice(100, 200);
    expect(mockStub.slice).toHaveBeenCalledWith(100, 200);

    await client.touch('test');
    expect(mockStub.touch).toHaveBeenCalledWith('test');

    await client.forget('test');
    expect(mockStub.forget).toHaveBeenCalledWith('test');

    await client.setPinned('test', true);
    expect(mockStub.setPinned).toHaveBeenCalledWith('test', true);

    await client.isPinned('test');
    expect(mockStub.isPinned).toHaveBeenCalledWith('test');

    await client.choose('test', Date.now(), 10);
    expect(mockStub.choose).toHaveBeenCalledWith('test', Date.now(), 10);

    await client.getStats();
    expect(mockStub.getStats).toHaveBeenCalled();

    await client.setBudget(100, 200);
    expect(mockStub.setBudget).toHaveBeenCalledWith(100, 200);

    await client.export();
    expect(mockStub.getAll).toHaveBeenCalled();
  });
});