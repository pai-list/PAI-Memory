import { DurableObject } from 'cloudflare:workers';
import { MemoryEntry, MemoryQuery, MemoryResult } from '../types';

interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ARTIFACTS: R2Bucket;
  MEMORY: VectorizeIndex;
  AI: Ai;
}

interface Ai {
  run(model: string, options: { text: string[] }): Promise<{ data: number[][] }>;
}

export class MemoryRouter extends DurableObject<Env> {
  private layers: Map<string, MemoryEntry[]> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<Map<string, MemoryEntry[]>>('layers');
      if (stored) {
        this.layers = stored;
      } else {
        const layerNames = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
        for (const layer of layerNames) {
          this.layers.set(layer, []);
        }
      }
    });
  }

  async remember(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'accessedAt' | 'accessCount'>): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    
    const newEntry: MemoryEntry = {
      ...input,
      id,
      createdAt: Date.now(),
      accessedAt: now,
      accessCount: 0
    };

    const layerEntries = this.layers.get(input.layer) || [];
    layerEntries.push(newEntry);
    this.layers.set(input.layer, layerEntries);

    // Generate embedding if needed
    if (input.layer === 'L3' || input.layer === 'L2') {
      newEntry.embedding = await this.generateEmbedding(input.content);
    }

    await this.persist();
    return id;
  }

  async recall(query: MemoryQuery): Promise<MemoryResult[]> {
    const layers = query.layers || ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
    let results: MemoryResult[] = [];

    for (const layer of layers) {
      const entries = this.layers.get(layer) || [];

      if ((layer === 'L2' || layer === 'L3') && entries.length > 0) {
        // Vector search for L2, L3
        const queryEmbedding = await this.generateEmbedding(query.query);
        const filtered = entries.filter((e): e is MemoryEntry & { embedding: number[] } => !!e.embedding);
        const vectorResults = filtered
          .map(e => ({
            ...e,
            similarity: this.cosineSimilarity(queryEmbedding, e.embedding!)
          }))
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

        let filteredResults = vectorResults;
        if (query.minConfidence) {
          filteredResults = filteredResults.filter(e => e.metadata.confidence >= (query.minConfidence || 0));
        }
        if (query.tags?.length) {
          filteredResults = filteredResults.filter(e => 
            query.tags!.some(t => e.metadata.tags.includes(t))
          );
        }
        results.push(...filteredResults.slice(0, query.limit || 10));
        continue;
      }

      // Text search for other layers
      let textResults = entries
        .filter(e => e.content.toLowerCase().includes(query.query.toLowerCase()))
        .sort((a, b) => b.accessedAt - a.accessedAt);

      if (query.minConfidence) {
        textResults = textResults.filter(e => e.metadata.confidence >= (query.minConfidence || 0));
      }

      if (query.tags?.length) {
        textResults = textResults.filter(e => 
          query.tags!.some(t => e.metadata.tags.includes(t))
        );
      }

      results.push(...textResults.slice(0, query.limit || 10));
    }

    // Update access stats
    for (const result of results) {
      result.accessedAt = Date.now();
      result.accessCount++;
    }

    await this.persist();
    return results.slice(0, query.limit || 10);
  }

  async promote(entryId: string, fromLayer: string, toLayer: string): Promise<void> {
    const fromEntries = this.layers.get(fromLayer) || [];
    const entryIndex = fromEntries.findIndex(e => e.id === entryId);
    
    if (entryIndex === -1) throw new Error('Entry not found');

    const removed = fromEntries.splice(entryIndex, 1);
    if (removed.length === 0) throw new Error('Entry not found after splice');
    const entry = removed[0]!;
    entry.layer = toLayer as any;
    
    const toEntries = this.layers.get(toLayer) || [];
    toEntries.push(entry);
    
    await this.persist();
  }

  async archive(entryId: string): Promise<void> {
    for (const [layer, entries] of this.layers) {
      const index = entries.findIndex(e => e.id === entryId);
      if (index !== -1) {
        const removed = entries.splice(index, 1);
        if (removed.length > 0) {
          const entry = removed[0]!;
          entry.layer = 'L7';
          const l7 = this.layers.get('L7') || [];
          l7.push(entry);
          await this.persist();
          return;
        }
      }
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('layers', this.layers);
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    const result = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [text]
    }) as { data?: number[][] };
    return result.data?.[0] ?? [];
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}