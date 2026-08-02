/**
 * PAI-Memory L2 Episodic Chain - Durable Object Entry Point
 *
 * Spec: docs/PAI-MEM-SPEC.md §3 (L2), §5.1/5.2/5.3/5.5, D2, D6, D7.
 *
 * This is the Cloudflare Durable Object entry point for the L2 Episodic Chain.
 * It exports the L2EpisodicDO class which handles SQLite persistence,
 * budget enforcement, and restart recovery.
 */

import { L2EpisodicDO, L2Client, L2DOConfig } from './l2-do-adapter';

// Re-export for external use
export { L2EpisodicDO, L2Client, L2DOConfig } from './l2-do-adapter';

// Export types
export type { L2DOConfig, L2DOState, L2EntryRow } from './l2-do-adapter';

// Durable Object export
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route to the appropriate DO instance based on the path
    // For now, we use a single DO instance for all L2 operations
    // In production, you might shard by agentId or conversationId
    const id = env.L2_EPISODIC_DO.idFromName('l2-episodic-chain');
    const stub = env.L2_EPISODIC_DO.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Type definitions for the Worker environment
interface Env {
  L2_EPISODIC_DO: DurableObjectNamespace;
  DB: D1Database;
}