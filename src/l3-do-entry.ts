/**
 * PAI-Memory L3 Fact Graph - Durable Object Entry Point
 *
 * Spec: docs/PAI-MEM-L3-SPEC.md §1–§7. Parent: docs/PAI-MEM-SPEC.md §3 (L3),
 * §4 numerics cascade, §5 power-law decay, §6 the clock decides, D2/D3/D4, D6.
 *
 * This is the Cloudflare Durable Object entry point for the L3 Fact Graph.
 * It exports the L3FactGraphDO class which handles SQLite persistence,
 * budget enforcement, and restart recovery.
 */

import { L3FactGraphDO, L3Client, L3DOConfig } from './l3-do-adapter';

// Re-export for external use
export { L3FactGraphDO, L3Client, L3DOConfig } from './l3-do-adapter';

// Export types
export type { L3DOConfig } from './l3-do-adapter';
export type { L3OverflowReason, FactRecord, Int8Quantization } from './l3-facts-semantic';

// Durable Object export
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route to the appropriate DO instance based on the path
    // For now, we use a single DO instance for all L3 operations
    // In production, you might shard by agentId or conversationId
    const id = env.L3_FACTS_DO.idFromName('l3-fact-graph');
    const stub = env.L3_FACTS_DO.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Type definitions for the Worker environment
interface Env {
  L3_FACTS_DO: DurableObjectNamespace;
  DB: D1Database;
}