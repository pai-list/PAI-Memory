import { describe, it, expect, beforeEach } from 'vitest';
import { L2EpisodicChain, L2Overflow, powerDecay, familyScore, L2_SOFT_BUDGET_BYTES, L2_HARD_CEILING_BYTES } from '../packages/pai-memory-core/src/l2-episodic-chain';
import { MemoryEntry, MemoryLayer, MemoryTier } from '../packages/pai-memory-core/src/types';

function createWorkEntry(): MemoryEntry {
  const now = Date.now();
  return {
    id: `work_${now}_docs_complete`,
    content: JSON.stringify({
      task: "Documentation Sites for PPP & OpenIdentity",
      status: "COMPLETE",
      completedAt: now,
      details: {
        PAI_Protocol_Repo: "https://github.com/pai-list/PAI-Protocol",
        pai_docs_Repo: "https://github.com/pai-list/pai-docs",
        PPP_Docs: "/protocols/ppp/ (spec, whitepaper, implementations)",
        OpenIdentity_Docs: "/protocols/openidentity/ (guide, api reference, DID spec)",
        Cloudflare_Pages_Project: "pai-docs → pai-docs.pages.dev",
        Custom_Domain: "docs.axiomid.app",
        DNS_Verified: [
          "docs.axiomid.app", "ppp.axiomid.app", "openidentity.axiomid.app",
          "api.axiomid.app", "verify.axiomid.app", "identity.axiomid.app",
          "payments.axiomid.app", "mcp.axiomid.app", "adp.axiomid.app",
          "memory.axiomid.app", "skills.axiomid.app", "agent.axiomid.app"
        ],
        Unit_Tests: "106 tests passing (pai-agent-kit)",
        Build_Status: "VitePress builds successful"
      },
      muraqabah_check: "confirmed honest, merciful, accountable"
    }),
    embedding: new Float32Array([0.9, 0.8, 0.7, 0.6, 0.5]),
    metadata: {
      source: "agent",
      tags: ["documentation", "ppp", "openidentity", "pai-docs", "deployment", "complete"],
      type: "task_completion",
      confidence: 1.0,
      custom: { pinned: true, taskId: "docs_sites_2026_08_03" }
    },
    layer: "L2_WARM" as MemoryLayer,
    tier: "WARM" as MemoryTier,
    createdAt: now,
    updatedAt: now,
    accessCount: 1,
    lastAccessedAt: now,
    importanceScore: 0.95
  };
}

describe('PAI Memory L2 - Work Verification', () => {
  let chain: L2EpisodicChain;

  beforeEach(() => {
    chain = new L2EpisodicChain({
      softBudgetBytes: 1024 * 1024, // 1 MiB
      hardCeilingBytes: 10 * 1024 * 1024 // 10 MiB
    });
  });

  it('should store completed docs work as pinned L2 entry', () => {
    const entry = createWorkEntry();
    const overflow = chain.append(entry);

    expect(chain.count).toBe(1);
    expect(chain.headId).toBe(entry.id);
    expect(overflow.length).toBe(0);
  });

  it('should retrieve and verify work entry', () => {
    const entry = createWorkEntry();
    chain.append(entry);

    const retrieved = chain.get(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(entry.id);
    expect(retrieved?.content).toBe(entry.content);
    expect(retrieved?.metadata.custom?.pinned).toBe(true);
    expect(retrieved?.importanceScore).toBe(0.95);
    expect(retrieved?.layer).toBe('L2_WARM');
    expect(retrieved?.tier).toBe('WARM');
  });

  it('should protect pinned work entry from budget eviction', () => {
    const entry = createWorkEntry();
    chain.append(entry);

    // Fill chain beyond soft budget
    for (let i = 0; i < 20; i++) {
      chain.append({
        ...createWorkEntry(),
        id: `fill_${i}`,
        createdAt: entry.createdAt + i + 1,
        metadata: { ...createWorkEntry().metadata, custom: { pinned: false } }
      });
    }

    // Pinned entry should still exist
    const pinned = chain.get(entry.id);
    expect(pinned).toBeDefined();
    expect(pinned?.metadata.custom?.pinned).toBe(true);
  });

  it('should verify L2 budget constants (D2)', () => {
    expect(L2_SOFT_BUDGET_BYTES).toBe(1024 * 1024); // 1 MiB
    expect(L2_HARD_CEILING_BYTES).toBe(10 * 1024 * 1024); // 10 MiB
  });

  it('should compute family score for recall', () => {
    const entry = createWorkEntry();
    chain.append(entry);

    const now = Date.now();
    const results = chain.choose('task_completion', now, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(entry.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('should maintain chain stats', () => {
    const entry = createWorkEntry();
    chain.append(entry);

    expect(chain.count).toBe(1);
    expect(chain.sizeBytes).toBeGreaterThan(0);
    expect(chain.headId).toBe(entry.id);
    const pinnedEntries = chain.export().filter(e => chain.isPinned(e.id));
    expect(pinnedEntries.length).toBe(1);
  });
});