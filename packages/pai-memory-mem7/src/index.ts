/**
 * @pai/memory-mem7 — mem7 adapter for PAI Memory Layer (L5)
 *
 * Wraps mem7's Rust-powered MemoryEngine into PAI's MemoryLayerAdapter
 * interface, bringing Ebbinghaus decay, graph recall, and context scoring
 * to the PAI Universe.
 *
 * Install:  npm install @pai/memory-mem7
 * Requires: @mem7ai/mem7 (bundled), Ollama or OpenAI-compatible API
 *
 * Zero-cost mode: Ollama + in-memory FlatIndex — no paid services needed.
 */

import {
  type MemoryEngine,
  type JsMemoryAction,
  MemoryEngine as Mem7Engine,
  initTelemetry,
  shutdownTelemetry,
} from "@mem7ai/mem7";

import { z } from "zod";

// ─────────────────────────────────────────────
// PAI Memory Layer Types (from pai-memory-core)
// ─────────────────────────────────────────────

export enum MemoryLayer {
  L1_HOT = "hot",
  L2_WARM = "warm",
  L3_FACTS = "facts",
  L4_CODE = "code",
  L5_TRUST = "trust",
  L6_EDGE = "edge",
  L7_ARCHIVE = "archive",
}

export enum MemoryTier {
  EPHEMERAL = "ephemeral",
  PERSISTENT = "persistent",
  ARCHIVAL = "archival",
}

export interface MemoryEntry {
  id?: string;
  content: string;
  role?: "user" | "assistant" | "system";
  userId: string;
  sessionId?: string;
  memoryType?: "factual" | "preference" | "procedural" | "episodic";
  metadata?: Record<string, unknown>;
  createdAt?: string;
  importance?: number;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  memoryType?: string;
  createdAt?: string;
}

export interface SearchQuery {
  query: string;
  userId?: string;
  limit?: number;
  threshold?: number;
  taskType?: string;
  memoryType?: string;
}

export interface MemoryStats {
  totalEntries: number;
  sizeBytes: number;
  layer: MemoryLayer;
}

// ─────────────────────────────────────────────
// mem7 Adapter — wraps @mem7ai/mem7 MemoryEngine
// ─────────────────────────────────────────────

export interface Mem7AdapterConfig {
  /** LLM provider (OpenAI-compatible). Default: Ollama on localhost */
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  /** Embedding provider. Default: Ollama on localhost */
  embedding?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dims?: number;
  };
  /** Vector store. Default: in-memory FlatIndex (zero-cost) */
  vectorStore?: "flat" | "upstash";
  /** Upstash config (only needed if vectorStore = "upstash") */
  upstash?: {
    url: string;
    token: string;
  };
  /** Graph store. Default: in-memory FlatGraph (zero-cost) */
  graphStore?: "flat" | "kuzu" | "neo4j";
  /** Enable telemetry (OpenTelemetry OTLP) */
  telemetry?: boolean;
  /** Memory decay config */
  decay?: {
    baseHalfLifeSecs?: number;  // default: 604800 (7 days)
    decayShape?: number;         // default: 0.8
    minRetention?: number;       // default: 0.1
    rehearsalFactor?: number;    // default: 0.5
  };
  /** Context scoring config */
  contextScoring?: boolean;
}

const DEFAULT_CONFIG: Mem7AdapterConfig = {
  llm: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "qwen2.5:7b",
  },
  embedding: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "mxbai-embed-large",
    dims: 1024,
  },
  vectorStore: "flat",
  graphStore: "flat",
  telemetry: false,
  contextScoring: true,
};

/**
 * Mem7Adapter wraps mem7's MemoryEngine into PAI's MemoryLayerAdapter pattern.
 *
 * Usage:
 * ```ts
 * const adapter = await Mem7Adapter.create({ ... });
 * const id = await adapter.store({ content: "Alice loves tennis", userId: "alice" });
 * const results = await adapter.search({ query: "What sports?", userId: "alice" });
 * ```
 */
export class Mem7Adapter {
  readonly layer = MemoryLayer.L5_TRUST;
  readonly tier = MemoryTier.PERSISTENT;
  readonly name = "mem7";

  private engine!: MemoryEngine;
  private config: Mem7AdapterConfig;
  private initialized = false;

  private constructor(config: Mem7AdapterConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Create and initialize a mem7 adapter instance. */
  static async create(config: Mem7AdapterConfig = {}): Promise<Mem7Adapter> {
    const adapter = new Mem7Adapter(config);
    await adapter.initialize();
    return adapter;
  }

  // ── Lifecycle ──

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.telemetry) {
      initTelemetry({ serviceName: "pai-memory-mem7" });
    }

    const mem7Config: Record<string, unknown> = {
      llm: {
        base_url: this.config.llm!.baseUrl,
        api_key: this.config.llm!.apiKey,
        model: this.config.llm!.model,
      },
      embedding: {
        base_url: this.config.embedding!.baseUrl,
        api_key: this.config.embedding!.apiKey,
        model: this.config.embedding!.model,
        dims: this.config.embedding!.dims,
      },
      decay: this.config.decay ?? {
        base_half_life_secs: 604800,
        decay_shape: 0.8,
        min_retention: 0.1,
        rehearsal_factor: 0.5,
      },
    };

    if (this.config.vectorStore === "upstash" && this.config.upstash) {
      (mem7Config as any).vector = {
        provider: "upstash",
        url: this.config.upstash.url,
        token: this.config.upstash.token,
      };
    }

    this.engine = await Mem7Engine.create(JSON.stringify(mem7Config));
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.config.telemetry) {
      shutdownTelemetry();
    }
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      // Quick probe: store and delete a test entry
      const id = await this.engine.add(
        [{ role: "system", content: "__healthcheck__" }],
        "__probe__"
      );
      await this.engine.deleteMemory(id);
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - start, details: String(err) };
    }
  }

  // ── CRUD ──

  /** Store a memory entry. Returns the memory ID. */
  async store(entry: MemoryEntry): Promise<string> {
    const messages = entry.content
      ? [{ role: entry.role ?? "user", content: entry.content }]
      : [];

    const userId = entry.userId;
    const sessionId = entry.sessionId;

    return await this.engine.add(messages, userId, sessionId ?? undefined);
  }

  /** Search for relevant memories. */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const results = await this.engine.search(
      query.query,
      query.userId ?? "__all__",
      query.limit ?? 10,
      query.threshold ?? 0.0,
      query.taskType,
    );

    return results.map((r: any) => ({
      id: r.id ?? r.memory_id ?? "",
      content: r.content ?? r.text ?? "",
      score: r.score ?? 0,
      memoryType: r.memory_type,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  }

  /** Delete a memory by ID. */
  async delete(id: string): Promise<void> {
    await this.engine.deleteMemory(id);
  }

  /** Delete all memories for a user. */
  async clearUser(userId: string): Promise<void> {
    await this.engine.deleteUser(userId);
  }

  // ── Stats ──

  async getStats(): Promise<MemoryStats> {
    return {
      totalEntries: 0, // mem7 doesn't expose count yet
      sizeBytes: 0,
      layer: MemoryLayer.L5_TRUST,
    };
  }

  // ── Convenience ──

  /** Add a conversational turn and automatically extract + store memories. */
  async add(
    content: string,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    return await this.store({ content, userId, sessionId, role: "user" });
  }
}

// ─────────────────────────────────────────────
// MemoryManager — Unified access to mem7
// ─────────────────────────────────────────────

export class MemoryManager {
  private adapter: Mem7Adapter;

  private constructor(adapter: Mem7Adapter) {
    this.adapter = adapter;
  }

  /** Create a MemoryManager with default zero-cost config (Ollama + FlatIndex). */
  static async create(config?: Mem7AdapterConfig): Promise<MemoryManager> {
    const adapter = await Mem7Adapter.create(config);
    return new MemoryManager(adapter);
  }

  get adapter_(): Mem7Adapter {
    return this.adapter;
  }

  /** Remember something. */
  async remember(
    content: string,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    return await this.adapter.add(content, userId, sessionId);
  }

  /** Recall relevant memories. */
  async recall(
    query: string,
    userId?: string,
    limit = 10,
  ): Promise<SearchResult[]> {
    return await this.adapter.search({ query, userId, limit });
  }

  /** Forget a specific memory. */
  async forget(id: string): Promise<void> {
    return await this.adapter.delete(id);
  }

  /** Clean shutdown. */
  async destroy(): Promise<void> {
    return await this.adapter.shutdown();
  }
}

// ─────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────

export function ollamaConfig(model = "qwen2.5:7b"): Mem7AdapterConfig {
  return {
    llm: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model },
    embedding: {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "mxbai-embed-large",
      dims: 1024,
    },
    vectorStore: "flat",
    graphStore: "flat",
    telemetry: false,
  };
}

export function openaiConfig(apiKey: string, model = "gpt-4o"): Mem7AdapterConfig {
  return {
    llm: { baseUrl: "https://api.openai.com/v1", apiKey, model },
    embedding: {
      baseUrl: "https://api.openai.com/v1",
      apiKey,
      model: "text-embedding-3-small",
      dims: 1536,
    },
    vectorStore: "flat",
    graphStore: "flat",
  };
}
