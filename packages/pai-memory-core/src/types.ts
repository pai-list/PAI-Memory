// PAI-Memory Core Types - 7-Layer Agent Memory System

export enum MemoryLayer {
  L1_HOT = 'L1_HOT',           // sqlite-vec: <1ms, 100MB
  L2_WARM = 'L2_WARM',         // Ghost pgvector: <50ms, 10GB
  L3_FACTS = 'L3_FACTS',       // Neon pgvector: cloud sync
  L4_CODE = 'L4_CODE',         // Qdrant local: code embeddings
  L5_TRUST = 'L5_TRUST',       // Git + Sigstore: immutable
  L6_EDGE = 'L6_EDGE',         // Firestore: realtime sync
  L7_ARCHIVE = 'L7_ARCHIVE',   // R2 + Parquet: analytical
}

export enum MemoryTier {
  HOT = 'HOT',       // L1
  WARM = 'WARM',     // L2
  COOL = 'COOL',     // L3, L4
  COLD = 'COLD',     // L5, L6, L7
}

export interface MemoryConfig {
  layers: LayerConfig[];
  promotionThresholds: PromotionThresholds;
  retention: RetentionPolicy;
}

export interface LayerConfig {
  layer: MemoryLayer;
  enabled: boolean;
  capacity: string;        // e.g., "100MB", "10GB"
  latencyTargetMs: number; // SLA
  syncStrategy: 'async' | 'sync' | 'scheduled';
}

export interface PromotionThresholds {
  accessCount: number;     // Promote after N accesses
  ageMs: number;          // Demote after N ms
  importanceScore: number; // 0-1, manual boost
}

export interface RetentionPolicy {
  hotTtlMs: number;       // L1 TTL
  warmTtlMs: number;      // L2 TTL
  coolTtlMs: number;      // L3/L4 TTL
  coldTtlMs: number;      // L5/L6/L7 TTL (essentially infinite)
}

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: MemoryMetadata;
  layer: MemoryLayer;
  tier: MemoryTier;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  trustAnchor?: TrustAnchor;
}

export interface MemoryMetadata {
  source: string;           // 'agent', 'user', 'ingest', 'web'
  agentId?: string;         // Which agent created this
  conversationId?: string;  // Link to conversation
  tags: string[];
  type: 'fact' | 'procedure' | 'preference' | 'code' | 'context' | 'episodic';
  confidence: number;       // 0-1
  language?: string;
  projectId?: string;
  filePath?: string;
  functionName?: string;
  lineStart?: number;
  lineEnd?: number;
  gitCommit?: string;
  gitBranch?: string;
  custom: Record<string, unknown>;
}

export interface TrustAnchor {
  sigstoreBundleId: string;
  rekorLogId: string;
  gitCommitHash: string;
  gitRepoUrl: string;
  timestamp: number;
  publicKey: string;
  signature: string;
  payloadHash: string;
}

export interface SearchQuery {
  query: string;
  embedding?: number[];
  layers?: MemoryLayer[];
  limit: number;
  threshold: number;        // Similarity threshold 0-1
  filters?: SearchFilters;
  rerank?: boolean;
}

export interface SearchFilters {
  agentId?: string;
  conversationId?: string;
  tags?: string[];
  type?: MemoryEntry['metadata']['type'];
  dateRange?: { start: number; end: number };
  projectId?: string;
  minConfidence?: number;
  minImportance?: number;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  layer: MemoryLayer;
  latencyMs: number;
}

export interface IngestOptions {
  documents: IngestDocument[];
  targetLayers: MemoryLayer[];
  generateEmbeddings: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
  extractMetadata?: boolean;
}

export interface IngestDocument {
  content: string;
  metadata: Partial<MemoryMetadata>;
  id?: string;
}

export interface IngestResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: IngestError[];
  layerDistribution: Record<MemoryLayer, number>;
  latencyMs: number;
}

export interface IngestError {
  documentId: string;
  error: string;
  layer?: MemoryLayer;
}

export interface SyncOptions {
  sourceLayer: MemoryLayer;
  targetLayer: MemoryLayer;
  strategy: 'full' | 'incremental' | 'delta';
  conflictResolution: 'source-wins' | 'target-wins' | 'merge' | 'manual';
  filter?: SearchFilters;
}

export interface SyncResult {
  sourceLayer: MemoryLayer;
  targetLayer: MemoryLayer;
  recordsExamined: number;
  recordsSynced: number;
  conflicts: SyncConflict[];
  latencyMs: number;
}

export interface SyncConflict {
  sourceId: string;
  targetId: string;
  sourceContent: string;
  targetContent: string;
  sourceUpdatedAt: number;
  targetUpdatedAt: number;
  resolution: 'source' | 'target' | 'merged' | 'pending';
}

export interface MemoryStats {
  layer: MemoryLayer;
  entryCount: number;
  sizeBytes: number;
  avgLatencyMs: number;
  hitRate: number;
  oldestEntry: number;
  newestEntry: number;
  health: 'healthy' | 'degraded' | 'down';
  lastSync: number;
}

export interface MemoryHealth {
  overall: 'healthy' | 'degraded' | 'down';
  layers: MemoryStats[];
  totalEntries: number;
  totalSizeBytes: number;
  promotionRate: number;
  demotionRate: number;
  conflictRate: number;
}

// MCP Tool Types
export interface MCPToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

export interface RecallParams {
  query: string;
  layers?: MemoryLayer[];
  limit?: number;
  threshold?: number;
  filters?: SearchFilters;
}

export interface RecallResult {
  results: SearchResult[];
  totalLatencyMs: number;
  layersQueried: MemoryLayer[];
}

export interface RememberParams {
  content: string;
  metadata: Partial<MemoryMetadata>;
  targetLayers?: MemoryLayer[];
  generateTrustAnchor?: boolean;
}

export interface RememberResult {
  entryId: string;
  layersStored: MemoryLayer[];
  trustAnchor?: TrustAnchor;
  latencyMs: number;
}

export interface IngestParams extends IngestOptions {}

export interface IngestResultResponse extends IngestResult {}

export interface SearchParams extends SearchQuery {}

export interface SearchResultResponse {
  results: SearchResult[];
  totalLatencyMs: number;
}

export interface SyncParams extends SyncOptions {}

export interface SyncResultResponse extends SyncResult {}

export interface StatsParams {
  layers?: MemoryLayer[];
}

export interface StatsResult {
  stats: MemoryStats[];
  health: MemoryHealth;
}

// Agent-facing simplified types
export interface AgentMemory {
  recall(query: string, options?: RecallOptions): Promise<AgentRecallResult>;
  remember(content: string, options?: RememberOptions): Promise<AgentRememberResult>;
  search(query: string, options?: SearchOptions): Promise<AgentSearchResult>;
}

export interface RecallOptions {
  limit?: number;
  threshold?: number;
  layers?: MemoryLayer[];
  conversationId?: string;
}

export interface AgentRecallResult {
  memories: Array<{
    content: string;
    metadata: MemoryMetadata;
    score: number;
    layer: MemoryLayer;
  }>;
  summary: string;
}

export interface RememberOptions {
  type?: MemoryMetadata['type'];
  tags?: string[];
  conversationId?: string;
  projectId?: string;
  importance?: number;
  generateTrustAnchor?: boolean;
}

export interface AgentRememberResult {
  entryId: string;
  trustAnchor?: TrustAnchor;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  filters?: SearchFilters;
}

export interface AgentSearchResult {
  results: Array<{
    content: string;
    metadata: MemoryMetadata;
    score: number;
    layer: MemoryLayer;
  }>;
}

// ── L2/L3 Overflow types (for cross-layer promotion) ──

export interface L2Overflow {
  entry: MemoryEntry;
  reasons: 'budget' | 'hard-cap';
}

export type L3OverflowReason = 'budget' | 'superseded' | 'expired';

export interface L3Overflow {
  factKey: string;
  serial: number;
  embedding: Float32Array;
  mat256: Float32Array;
  int8Params: {
    data: number[];
    mean: number[];
    scale: number[];
    dim: number;
  };
  reason: L3OverflowReason;
}

export interface L3DOConfig {
  softBudgetBytes?: number;
  hardCeilingBytes?: number;
}