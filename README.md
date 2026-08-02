# PAI-Memory — 7-Layer Agent Memory

**Persistent. Verifiable. Shared.** The memory layer for the PAI ecosystem.

> **Honest Status (2026-08-02):** L1 (Working Memory) + L2 (Episodic Chain) implemented as in-memory structures. L2 DO-SQLite Adapter in progress. Full 7-layer spec ratified in `docs/PAI-MEM-SPEC.md`. Zero external providers — Cloudflare-native only (D7 ratified).

---

## Current Implementation Status

| Layer | Name | Status | Implementation |
|-------|------|--------|----------------|
| **L1** | Working Memory | ✅ **Done** | In-memory drain ring, 8 pinned slots, 256KB cap, LRU eviction, overflow → L2 |
| **L2** | Episodic Chain | ✅ **In-Memory Done** | Chronological chain, power-law decay (β=1.2), 1MiB soft / 10MiB hard budget, pins survive eviction |
| **L2** | DO-SQLite Adapter | 🔄 **In Progress** | Durable Object + SQLite persistence, D2 budgets enforced |
| **L3** | Facts / Semantic | ⏳ **Planned** | WASM-SIMD HNSW + Matryoshka + ValidityWindow (D6: Rust→WASM) |
| **L4** | Code / Procedural | ⏳ **Planned** | tree-sitter WASM sidecar, fork/snapshot model |
| **L5** | Trust / Audit | ⏳ **Planned** | TrustChain hash-chain + Sigstore/Rekor |
| **L6** | Shared / Edge | ⏳ **Planned** | DO gossip + energy attenuation |
| **L7** | Cold / Archive | ⏳ **Planned** | Parquet-wasm → R2, R2 SQL reads |

**Spec:** `docs/PAI-MEM-SPEC.md` (v0.2, ratified 2026-08-02, D1–D7 binding)

---

## Implemented: L1 Working Memory (`packages/pai-memory-core/src/l1-working-memory.ts`)

- **Topology:** Drain ring (bounded ordered capsule) + 8 pinned slots
- **Capacity:** 256KB hard cap
- **Eviction:** LRU on drain ring; pinned slots never evicted
- **Overflow:** Pinned-full → promotes to L2
- **Tests:** 10 passing (drain ring, pinning, eviction, overflow, capacity)

---

## Implemented: L2 Episodic Chain — In-Memory (`packages/pai-memory-core/src/l2-episodic-chain.ts`)

- **Topology:** Chronological chain with temporal adjacency (`nearestBefore`, `slice`)
- **Decay:** Power-law `ret(t) = t^(−β)`, β=1.2 (episodic), identity β=0.013 (≳64k h half-life)
- **Family Score (D5.2):** `w1·importance + w2·(1+accesses)^γ·t^(−β) + w3·0.5^((t−last_access)/τ)`
- **Budgets (D2):** 1 MiB soft / 10 MiB hard ceiling
- **Pins:** Survive soft overflow (right-of-user)
- **Overflow:** `L2Overflow[]` returned for promotion to L3 — never silent truncation
- **Tests:** 17 passing (decay, familyScore, budget enforcement, pin survival, choose/ranking)

---

## In Progress: L2 DO-SQLite Adapter

**Goal:** Persist L2 episodic chain to Durable Object + SQLite, enforce D2 budgets, survive restarts.

- Durable Object class with SQLite storage
- Schema: `entries (id, content, embedding, createdAt, accessCount, pinned, ...)`
- Budget enforcement: soft=1MiB, hard=10MiB
- In-memory `L2EpisodicChain` becomes client; DO handles durability
- Unit tests: persistence, restart recovery, budget enforcement

---

## Zero External Providers (D7 Ratified)

| Layer | Service (Spec) | Current | Target (Cloudflare) |
|-------|----------------|---------|---------------------|
| L1 | sqlite-vec → | In-memory | DO memory |
| L2 | Ghost pgvector → | In-memory | DO-SQLite |
| L3 | Neon pgvector → | — | DO-SQLite + WASM HNSW |
| L4 | Qdrant local → | — | DO + tree-sitter WASM sidecar |
| L5 | Sigstore/Rekor → | trust-gate.ts (stub) | TrustChain + WebCrypto + Sigstore |
| L6 | Firestore → | — | DO gossip + R2 |
| L7 | R2 + Parquet → | — | R2 + Parquet-wasm + R2 SQL |

**No external providers used.** All dependencies in `package.json` are only those currently imported by implemented code.

---

## Quick Start (Current)

```bash
# Install
cd packages/pai-memory-core
npm install

# Run tests
npm test

# Typecheck
npm run typecheck

# Lint
npm run lint
```

---

## Architecture Reference

- **Full Spec:** `docs/PAI-MEM-SPEC.md` (v0.2, D1–D7 ratified)
- **Numerics Contract:** §4 (embedding dims, Matryoshka, sparse/dense hybrid)
- **Retention Model:** §5 (power-law decay, family score, adaptive budget, rehearsal)
- **Conflict/Edit Engine:** §6 (bitemporal, max-serial resolution, tiered forget)
- **Trust-Gate:** §7 (novelty, policy, read-bias)
- **API Surface:** §8
- **Implementation Phases:** §11 (P0–P5)
- **Shura Ratifications:** §12 (D1–D7 binding)

---

## License

MIT — Free for all agents, all humans, all purposes.

---

*PAI-Memory by Mohamed Abdelaziz. Part of the PAI ecosystem. Codename: Momerino (internal). Spec v0.2. Ratified 2026-08-02.*