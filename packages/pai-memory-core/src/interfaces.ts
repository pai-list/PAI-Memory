// Main Memory Interface - Abstract base for all layers

import {
  MemoryLayer,
  MemoryTier,
} from './types';

import type {
  MemoryEntry,
  MemoryMetadata,
  SearchQuery,
  SearchResult,
  SearchFilters,
  IngestOptions,
  IngestResult,
  SyncOptions,
  SyncResult,
  MemoryStats,
  MemoryHealth,
  TrustAnchor,
} from './types';

export interface MemoryLayerAdapter {
  readonly layer: MemoryLayer;
  readonly tier: MemoryTier;
  
  // Lifecycle
  initialize(config: LayerConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; details?: string }>;
  
  // CRUD
  store(entry: MemoryEntry): Promise<string>;
  retrieve(id: string): Promise<MemoryEntry | null>;
  update(id: string, entry: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  
  // Search
  search(query: SearchQuery): Promise<SearchResult[]>;
  searchByEmbedding(embedding: number[], options: SearchOptions): Promise<SearchResult[]>;
  
  // Batch
  batchStore(entries: MemoryEntry[]): Promise<string[]>;
  batchDelete(ids: string[]): Promise<void>;
  
  // Stats
  getStats(): Promise<MemoryStats>;
  count(): Promise<number>;
  size(): Promise<number>;
  
  // Sync
  syncFrom(source: MemoryLayerAdapter, options: SyncOptions): Promise<SyncResult>;
  export(filter?: SearchFilters): Promise<MemoryEntry[]>;
  import(entries: MemoryEntry[], options?: ImportOptions): Promise<number>;
}

export interface LayerConfig {
  layer: MemoryLayer;
  capacity: string;
  latencyTargetMs: number;
  syncStrategy: 'async' | 'sync' | 'scheduled';
  custom?: Record<string, unknown>;
}

export interface SearchOptions {
  limit: number;
  threshold: number;
  filters?: SearchFilters;
  rerank?: boolean;
}

export interface ImportOptions {
  overwrite?: boolean;
  generateTrustAnchors?: boolean;
  targetLayer?: MemoryLayer;
}

export interface MemoryManagerConfig {
  layers: LayerConfig[];
  promotionThresholds: {
    accessCount: number;
    ageMs: number;
    importanceScore: number;
  };
  retention: {
    hotTtlMs: number;
    warmTtlMs: number;
    coolTtlMs: number;
    coldTtlMs: number;
  };
  defaultEmbeddingModel?: string;
  embeddingDimensions?: number;
}

// Events for cross-layer coordination
export interface MemoryEvent {
  type: 'stored' | 'updated' | 'deleted' | 'promoted' | 'demoted' | 'synced';
  layer: MemoryLayer;
  entryId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type MemoryEventListener = (event: MemoryEvent) => void;

// Embedding provider interface
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly maxTokens: number;
  
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  tokenCount(text: string): number;
}

// Trust/Verification
export interface TrustVerifier {
  verifyAnchor(anchor: TrustAnchor): Promise<{ valid: boolean; details?: string }>;
  createAnchor(entry: MemoryEntry, privateKey: string): Promise<TrustAnchor>;
}

// Default configuration
export const DEFAULT_MEMORY_CONFIG: MemoryManagerConfig = {
  layers: [
    { layer: MemoryLayer.L1_HOT, capacity: '100MB', latencyTargetMs: 1, syncStrategy: 'async' },
    { layer: MemoryLayer.L2_WARM, capacity: '10GB', latencyTargetMs: 50, syncStrategy: 'async' },
    { layer: MemoryLayer.L3_FACTS, capacity: '1GB', latencyTargetMs: 200, syncStrategy: 'scheduled' },
    { layer: MemoryLayer.L4_CODE, capacity: '5GB', latencyTargetMs: 100, syncStrategy: 'scheduled' },
    { layer: MemoryLayer.L5_TRUST, capacity: 'unlimited', latencyTargetMs: 500, syncStrategy: 'sync' },
    { layer: MemoryLayer.L6_EDGE, capacity: '1GB', latencyTargetMs: 100, syncStrategy: 'async' },
    { layer: MemoryLayer.L7_ARCHIVE, capacity: 'unlimited', latencyTargetMs: 1000, syncStrategy: 'scheduled' },
  ],
  promotionThresholds: {
    accessCount: 3,
    ageMs: 24 * 60 * 60 * 1000, // 24 hours
    importanceScore: 0.7,
  },
  retention: {
    hotTtlMs: 7 * 24 * 60 * 60 * 1000,     // 7 days
    warmTtlMs: 30 * 24 * 60 * 60 * 1000,   // 30 days
    coolTtlMs: 365 * 24 * 60 * 60 * 1000,  // 1 year
    coldTtlMs: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
  },
  embeddingDimensions: 768,
};