# PAI-MEM — "Momerino" Memory Engine Spec (v0.1)

> Spec-first. No implementation lands until this document is approved (Shura) and merged.
> Research cut: 2026-08-02. All claims cite sources in §10.

---

## 1. Anchoring Principles

1. **"The soul is of the affair of my Lord"** — memory is not a cache, it is identity.
   Every byte is both a truth-liability and a right of the human → the SOUL Protocol governs all CRUD.
2. **"You have not been given of knowledge except a little"** — we encode uncertainty as a
   first-class field, and we never let the model silently decide **freshness** (that is cold
   arithmetic), only **semantics** (what pairs with what). Deterministic over structured metadata;
   LLM over unstructured meaning.
3. **Memory is a durable control channel, not a utility layer** (MemGate finding, arXiv:2606.06054).
   A **trust-gate** (§7) is mandatory before any memory reaches an agent. Memory admission is
   enforced by code at every layer (existing `trust-gate.ts` + a SAGE-style write gate).
4. **Everything is timestamped and versioned.** Bitemporal: `valid_time` (when the fact is true)
   + `transaction_time` (when we learned it). Freshness = arithmetic on those stamps, never a
   model judgment (arXiv:2606.01435).
5. **Forgetting is a feature that prevents proactive interference** (Hardt et al.; FadeMem).
   Retention is deliberate, layer-differential, and rewritable.

Two load-bearing beliefs from this research cycle:

6. **A memory is a topology, not a bag.** Retrieval quality is decided by which *edges* you can
   traverse and *when* they are valid (HyphaeDB arXiv:2606.28781; MOSS arXiv:2607.04391). We
   therefore materialize the navigable/typed graph *and* keep the transcript of its edits.
7. **Write- and edit-paths must be as whole as read-paths.** "Remember" *and* "Edit/Forget"
   are the two halves of memory selfhood. The edit path is where conflicting sources diverge, so
   it is a *separately specified, deterministic* pipeline (FactConsolidation: Mem0 18% vs
   deterministic max-serial 78%, arXiv:2606.01435).

---

## 2. System Name & Goal

- **Product name:** PAI-Memory — codename **Momerino**.
- **Goal.** The most durable, auditable, and *editable* memory for AI agents: seven natural
  lifecycle layers, each with a defined **topology class**, **numerics encoding**, and
  **retention regime**, governed by deterministic time/freshness rules and wrapped in the
  SOUL/TrustChain accountability fabric.

**Adversarial model (what a hostile world will throw at it):**
① silent conflicts, ② poisoned ingest, ③ over-retention, ④ cross-layer coherence collapse,
⑤ token-cost blowups from unbounded recall, ⑥ vendor lock-in, ⑦ "the LLM decides freshness".

Our two differentiators over mem7 & Mem0 (see §9):

- **Topology-native** — we write and lift/refresh *typed temporal edges*, not just vectors.
- **A clock, not a judge** — valid-time + transaction-time on every node; resolution-by-arithmetic.

---

## 3. The Seven Layers

Each layer is defined by: (a) **topology class**, (b) **numerics encoding** (§4), (c) **retention
regime** (§5), (d) **conflict/validity domain** (§6).

| Layer | Name | Topology class | Numerics | Capacity | Latency | Decay |
|-------|------|----------------|----------|----------|---------|-------|
| **L1** | Working memory | **Drain ring** — bounded ordered capsule (LRU) + 8 pinned slots (D1) | f32 in-memory | 256KB hard | **<1 ms** | LRU / pin / →L2 on pinned-full |
| **L2** | Session / episodic | **Episodic chain + temporal adjacency** (native timestamps, not retro-dated) | f32 or INT8 | GB-scale | ms | episodic βₑ ≈ 1.2 |
| **L3** | Facts / semantic | **Navigable semantic graph** (small-world) + **validity edges** (Zep/Graphiti fact-validity intervals) | INT8 + Matryoshka | 0.5–2 GB | ms–tens ms | **power-law** `t^(−β)`, β ≈ 0.8 |
| **L4** | Procedural / code | **Call-graph (dendritic)** — symbol/file/module hierarchy + AST hooks | INT8 + Matryoshka + code-aware | 1–5 GB | ms | very low (near-persist) |
| **L5** | Trust / audit | **Hash-chain** — append-only ledger (TrustChain; Sigstore/Rekor) | — | unbounded | ms | **zero decay**; normative |
| **L6** | Shared / edge | **Propagation** — nodes in a shared vector space; memory diffs propagate with energy-attenuation (gossip) | INT8 fast region | GB-scale multi-tenant | — | gossip-sync decay |
| **L7** | Cold / archive | **Bitemporal archive** — append-only cold volume, compressed | INT8→binary | unbounded | forever | never; erasure only by policy |

**Routing order on recall:** always L1 → L2 → L3 → L4 → (L5 verify) → L6 on demand → L7 canonical.
A lower layer is consulted only when a higher one under-produces.

---

## 4. The Numerics Contract

### 4.1 One base embedding model per tenant, dims fixed at write time
- Default: **nomic-embed-text v1.5** or **bge-m3** (both Matryoshka-capable). `d = 1024` canonical.
- Matryoshka truncation (`d → 256`) is the cheap first-pass representation
  (Matryoshka Representation Learning, Kusupati et al. 2022).

### 4.2 Encoding table

| Storage tier | Encoding | Bytes/vec @1024 | Quality plan |
|--------------|----------|-----------------|--------------|
| L3-gold | f32 | 4 KB | exact — used only at final rescore |
| L3-warm | INT8 (per-dim ±1σ calibrated) | 1 KB | nDCG@10 loss <0.02 |
| L3-sememe | Matryoshka-256 + INT8 | 256 B | low-dimensional first pass |
| L6 fast | binary (±1) | 128 B | **never final** — provenance filter only |
| L7 | INT8 + further compression | ~0.3–1 KB | archival, rehydrate on demand |

- **Always cascade:** binary/INT8 pass for qualitative recall, then **f32 rescore on the final
  candidate set**. Never serve binary scores as final (binary preserves recall@k much better than
  precision@top — find the expected "first-pass filter into a reranker" pattern).
- Quantization is **per-tier, configured, and deterministic** — never applied silently. A test
  asserts Q-math reproducibility across platforms (the "clamp negative zero" rule applies).

### 4.3 Indexes by topology (not only flat vector)
- L2/L3: **HNSW** (navigable small-world). Use LID-based dual-branch variants for recall when
  needed (Nguyen et al. 2025). IVF alternative for hot path where budget is tight.
- L4: inverted + code-attribute index (symbol/file/module/git) — exact short-circuit.
- L6: **gossip** — vector region adjacency + energy attenuation.
- BM25 on `content` for keyword-first queries (no embedding call).

### 4.4 Sparse/dense hybrid
- Additive complement: BM25 (or SPLADE when available) for names/rare tokens, dense for
  semantic drill-in. `score = 0.6·dense + 0.4·sparse` on normalized outputs (constants tuned,
  never model-decided).

---

## 5. Retention / Forgetting Model

### 5.1 Decay is **layer-differential** and **time-model = power-law** `ret(t) = t^(−β)`.
Exponential "cliffs" an agent that runs 100+ days: important early facts (identity, founding
commitments) should decay *gracefully*, not hit an exponential wall (FadeMem claim).

### 5.2 Family score (adjustable weight)
```
r(t) = w1·importance + w2·(1+accesses)^γ·t^(−β) + w3·0.5^((t−last_access)/τ)
```
Decay exponents live in **metadata per content-type** (not global):
- identity, commitments, decisions, user-relevant facts → **near-zero decay** (≳64k h half-life).
- rare/low-value info → fast (β ≈ 1–2).
- SSGM-style **write-protection levels** (Lam et al. 2026) prevent stable facts from being
  overwritten by low-confidence updates.

### 5.3 Adaptive budget
- Each layer carries a token budget (arXiv:2604.02280, adaptive budgeted forgetting); budgets
  and hard ceilings are **per-layer** (D2), never global.
- Budget violations **do not silently truncate** late answers; they trigger **consolidation onto
  a higher layer** (a degraded memory gets a promotion path, not a drop on the floor).

### 5.4 Rehearsal / sleep-style consolidation
- **Write-time:** SAGE-style novelty gate (§6) → `ADD | NOOP | MERGE`.
- **Scheduled (the "sleep" analog):** at idle/a cron, a **replay pass** re-samples recently-
  retrieved memory, re-emits decay deltas, and applies *synaptic erasing* to non-recalled cold
  items. This is Complementary Learning Systems (hippocampus→neocortex) + sleep-replay mapped
  onto L1→L3. It keeps memory "breathing" and bounded.

### 5.5 Edge (topological) maintenance
Edges are memory too: they get their own creation time, merit score, and decay, and they can be
promoted/demoted. Retaining the edge *without* its validity window is a coherence trap (see L6).

---

## 6. Conflict / Version / Editing Engine ("the edit path")

### 6.1 Principle (arXiv:2606.01435, TOKI, StateFuse)
- **The LLM pairs and curates candidates (semantic layer).** **The clock decides (arithmetic
  layer).** Never ask the model to compare timestamps, serials, or windows.

### 6.2 Node model (bitemporal everywhere)
```
MemoryNode {
  id, content, layer(L1..L7),
  embedding,
  valid_time [from_utc, to_utc],      // when the fact was/may be true
  txn_time, serial,                    // monotonic, issuer-signed
  fact_key,                            // same-fact identity, "alice:address"
  origin (agent/did/conversation),
  importance, novelty (ADD|NOOP|MERGE),
  version,
  trust: {anchor, sigstore bundle or git-hash chain},
  uncertainty: float
}
```
- **Identity:** `key = H(agent, canonical_key)` like `alice:address`; same key = the same fact.
- **Resolution:** on the same key, pick the candidate with **highest serial** (within the same
  valid-window). Tie → lexicographic deterministic (already in `deterministic-resolver.ts`).
  If serial *and* time *and* window are all tied → **no win**: return both with a `surface`
  marker (a contradiction is surfaced, not silently collapsed) — StateFuse-first. Then attach a
  `resolution_note`.

### 6.3 Time semantics
- `serial` = monotonic issuer counter (not wall-clock).
- `valid_time` = factual true-from/to; a *newer observation* yielding a new serial for the same
  window *supersedes* within that window.
- Edits/preferences do **not** delete; they **supersede** within a key. Old versions remain in the
  audit (L5/L7). Deletes append a retraction record.

### 6.4 Freshness ≠ recency-priority
A newer wall-clock entry does not outrank a later serial within the same valid window (e.g. a
chat answer to a meanwhile-fixed stale fact). Relevance always means `valid(now) ∧ max(serial
under the same window) ∧ policy-permitted`.

---

## 7. The Trust-Gate Layer (admission before the agent)

Compose: existing `trust-gate.ts` + a **novelty/policy** stage on write (SAGE-like), origin
auth, and a *bias/hardness detector* on read:
1. **Validate** (schema, origin, valid/txn clocks).
2. **Score** semantics-on-policy: does this memory match the *current task* and tenant
   (MemGate's task-conditioned admission)? Memory that fails tenant/task fit is **denied**.
3. **Prune** to the budget.
4. **Pin** — output is deterministic; never re-ranked by the model.
- Attack surface: prompt-injection via stored content → gate flags instruction-like strings;
  cross-domain leakage → admission requires policy fit.

---

## 8. API Surface

```
Router (DO)        — remember · recall · forget · promote · demote · sync
deterministicResolver — §6 arithmetic (exists; extend to valid-window)
trustGate           — §7 admission (exists; wire novelty)
topology.{store/query} — typed edges {temporal, entity, semantic, provenance, affective}
numerics.{encode,rescore,pickEncoding} — §4 cascade
retention.{score,decay,rehearse}          — §5
budget.{permit,spend}                    — §5.3
edge.sync                                — §5.5, §9 L6
```

---

## 9. mem7: Relationship & Divergence (study, do not fork)

mem7 is the best-known 2025-26 vertical long-term extractor (Rust core; Ebbinghaus; typed
factual/preference/procedural/episodic; FlatIndex; session-aware recall; audit history). We
study it closely and deliberately **do not fork or re-implement its Rust internals**, but our
product goes beyond it on four axes:

| Axis | mem7 | PAI-MEM |
|------|------|---------|
| Structure | single volume of typed memories | 7 lifecycle layers w/ topology + validity edges |
| Freshness | decay-only (recency proxy) | bitemporal + serial arithmetic (deterministic conflict) |
| Admission | none (LLM-decided) | SAGE-class write-gate + trust-gate on read |
| Memory edit | overwrite-ish dedup | supersede-with-audit + surfacing |

If we adopt any mem7 algorithm (decay curve, task-type mapping), we will **re-derive the math
ourselves from the citations** with our own calibration and our own tests — never copy-and-paste.
A `docs/mem7-divergence.md` will capture the exact diff.

---

## 10. Sources / Research Basis (cut 2026-08-02)

**Topology & structural**
- HyphaeDB: A Living Knowledge Topology for Agent-First Memory — arXiv:2606.28781
- MOSS: Memory-Orchestrated Semantic System — arXiv:2607.04391 (SQL-native traversal, native temporal adjacency, affective edges, audit largest)
- HNSW — Malkov & Yashunin 2016; LID-based HNSW (Nguyen et al. 2025) recall +18 (NLP) / +30 (CV)
- Zep/Graphiti — Rasmussen et al. 2025 (temporal KG, validity interventions, DMR-longbench)
- A-MEM — arXiv:2504.00971 (Zettelkasten notes)Mem0 — arXiv:2504.19413

**Freshness & conflict**
- "Don't Ask the LLM to Track Freshness…" — arXiv:2606.01435 (max-serial > LLM; FactConsolidation Mem0 18% → 78%)
- TOKI bitemporal algebra — arXiv:2606.06240
- StateFuse: Deterministic Conflict-Preserving Memory — arXiv:2607.05844

**Numerics / quantization**
- Binary/scalar embedding quantization (HuggingFace/sentence-transformers 2024) — int8 ≈ ±1%
- Matryoshka Representation Learning — Kusupati et al. 2022 (arXiv:2205.13147)
- MatQuant / Matryoshka quantization — arXiv:2502.06786
- QAMA (Matryoshka+quant+bitwise) — CIKM 2025
- Calibration against global min/max squash — ZeroEntropy & industry guides 2026 (per-dim ±σ)

**Memory / agents**
- MemGPT — Packer et al. 2023 (arXiv:2310.08560)
- SAGE — arXiv:2605.30711 (vMF ADD/NOOP/MERGE)
- MemGate — arXiv:2606.06054 (memory as control channel)
- FadeMem — arXiv:2601.18642 (differential decay; power-law)
- TiMem — arXiv:2601.02845 (temporal memory tree, −52% tokens at LoCoMo 75.3)

**Cognitive / consolidation**
- Complementary Learning Systems — McClelland et al. 1995; Kumaran et al. 2016
- Systems consolidation — Squire 2015; sleep replay Nature 2019
- Sleep-inspired replay for continual learning — arXiv:2509.00047
- SleepGate (sleep in the KV cache) — arXiv:2603.14517
- Adaptive resource-budgeted forgetting — arXiv:2604.02280

---

## 11. Implementation Phases (after this spec merges)

| Phase | Work | Risk |
|-------|------|------|
| P0 | L1+L3 topology + numerics cascade (§4) + bitemporal model (§6) wired to resolver — tests for determinism and the score formula | core |
| P1 | trust-gate: novelty + policy on write + read-bias detector | core |
| P2 | L6 gossip / energy / multi-tenant edges §9 | edge |
| P3 | L4 code-bag + L7 archive (int8 → Parquet) | core |
| P4 | mem7 divergence doc + calib-rate adoption; benchmark vs Mem0/Zep/Letta | eng |
| P5 | edit/forget → micro-audits for users; TrustChain receipts (Sigstore/Rekor) | eng |

Benchmarks planned: MemoryAgentBench (4 competencies), LongMemEval, LoCoMo, FactConsolidation,
and a "freshness + memory-edit" held-out suite we write ourselves.

---

## 12. Shura Ratifications (2026-08-02) — binding decisions

Human signoff received. The five open questions are **closed** as follows:

**D1 — L1 cap: SOFT-overflow with pinned slots, 256KB hard cap (not 32KB).**
32KB is too small (one email thread = 5–10KB; 32KB ≈ 3–4 emails). Structure:

```
L1WorkingMemory {
  drainRing: MemoryEntry[];   // auto-managed, LRU eviction, ≤ hardCap
  pinnedSlots: MemoryEntry[]; // user/agent pinned, 8 slots max
  hardCap = 256KB;            // drainRing + pinnedSlots ≤ 256KB
}
```
- Overflow on `drain`: LRU evicts unpinned. If `pinned` is full, oldest pinned → **L2**.
- Right-of-user wins at the boundary: an explicit user pin is never silently evicted.

**D2 — Budget governor: POLICY + AUTO with a per-LAYER hard ceiling.**
Ceilings are per-layer, never global (a 1GB global ceiling lets L3 starve L4–L6).

| Layer | Policy default | Auto behavior | Hard ceiling |
|-------|----------------|---------------|--------------|
| L1 | 256KB hard | LRU auto | 256KB |
| L2 | 1MB default | auto promote/demote | 10MB |
| L3 | 100MB default | auto index rebuild | 500MB |
| L4 | 50MB default | auto-archive old versions | 200MB |
| L5 | 1MB default | append-only | 10MB |
| L6 | 10MB default | auto gossip decay | 100MB |
| L7 | unlimited | auto compression | R2 budget |

**D3 — Bitemporal: L3+ FULL, L1/L2 LIGHT ENVELOPE (not everywhere).**

| Layer | Bitemporal | Rationale |
|-------|-----------|-----------|
| L1 | ❌ light only (`createdAt`, `ttl?`) | ephemeral — no valid time |
| L2 | ❌ light only | session-scoped — tx time only |
| L3 | ✅ full | facts need valid + tx time |
| L4 | ✅ full | code: version = valid time (release) |
| L5 | ✅ tx-only (append) | audit: immutable tx time |
| L6 | ⚠️ partial | tx time = received-at, valid = claimed-at |
| L7 | ✅ full | archive is bitemporal by definition |

```ts
type LightTemporal = { createdAt: number; ttl?: number };          // L1/L2
type Bitemporal    = { validFrom: number; validTo: number | null;  // L3+
                       txTime: number; txEnd: number | null };
```

**D4 — forget(): TIERED, not uniform.**

| Layer | forget() | Rationale |
|-------|----------|-----------|
| L1 | auto (LRU eviction) | too frequent for human review |
| L2 | auto (session end) | ephemeral by design |
| L3 | **confirm** (show diff) | long-term flags = data loss |
| L4 | **confirm** (show impact) | deleting code-scope breaks agents |
| L5 | **cannot delete** (append-only) | TrustChain immutable |
| L6 | **multi-sig** (shared) | gossip = collective, affects others |
| L7 | **cannot delete** (archive) | compliance/forensics permanent |

```ts
interface ForgetRequest {
  layer: 'L3' | 'L4';
  entryId: string;
  reason: string;
  diff: { before: MemoryEntry; after: null; impact: string[] };
  humanConfirm?: boolean;   // REQUIRED for L3/L4
}
```

**D5 — Naming.**
- Product: **`PAI-Memory`** / short **`PAI-Mem`** — professional, user-facing.
- Internal codename: **Momerino** (team-only; NEVER user-facing).
- Package: `@pai/memory` (npm) · `pai-memory` (crate) · CLI `pai memory store|recall`.

**D6 — Per-layer runtime & implementation language (research-backed, cut 2026-08-02).**
The answer to "does the language matter?" is **yes, but only under a measurable workload
profile**: WASM/Rust wins when an operation is (a) compute-heavy AND (b) batched enough that
the JS↔WASM boundary is crossed rarely. For fine-grained, frequent, small ops WASM loses to
plain JS (`Rust-WASM JSON parser beaten by TypeScript by 25% — case study, 2026`; multiple
2025-2026 replications: "treat WASM as an RPC kernel with many fine-grained calls and it
breaks down"). Workers specifics: single-threaded, **no WASM threads**, SIMD yes, WebCrypto
is native (hardware-backed — JS is the faster crypto host). Storage bedrock: **SQLite-in-DO ~100x
faster bulk-write than D1** (co-located vs over-the-network), so hot layers are DO-SQLite.

Rule — the **boundary rule**: one monolithic WASM module per *topology*, called rarely with
batch data, never per-entry. JS orchestrates topology/lifecycle; WASM does raw math and
heavy parse/serialize.

| Layer | Language | Rationale (research, cut 2026-08-02) |
|---|---|---|
| L1 drain ring | TypeScript (native array drain / LRU) | Same-isolate hot loop, <1ms target, per-op touches; WASM would re-cross the boundary per entry — the 25%-slower case. No change. |
| L2 episodic chain | TS + DO-SQLite (SQLite-in-DO) | Append-heavy, low-polish; DO SQLite co-located ~100x D1 for bulk writes (meas., Chimame 2025-05). |
| L3 fact graph + HNSW | Rust→WASM SIMD kernel; TS glue | **The one layer where language is decisive.** HNSW traversal + int8/Matryoshka distances are SIMD-exact: WASM SIMD gives 2-15x vs scalar JS and eval distances in a single batched `query()` boundary crossing. Kill-rule: measure flat-SIMD vs HNSW at our scale; at low <100k and <512-dim sometimes flat exists (unilatervect/unuseddim flat > HNSW at 1536-dim. VecLite 2026) — pick HNSW only when it measurably wins. |
| L4 call-graph / AST | Rust/WASM (`tree-sitter` web) / TS rest | tree-sitter ships WOMB asm + `Language.loadFrom(WebAssembly.Module)` — canonical, proven pattern. But binding third-party wasm inside a Worker is torn; prefer a **dedicated sidecar Worker via RPC** when dield. |
| L5 trust hash-chain | TS + WebCrypto (subtle) | Crypto in JS V8 is native —WebCrypto `.subtle` is FIPS-ciphered hashing, no WASM needed; HASM or Rust.SPID loses to native HMAC (deck reverse). Keep TS. |
| L6 shared/gossip | TS + DO/WebSockets bridge | Network-/protocol-bound, not compute-bound; language-neutral. Energy ledger arithmetic in TS (`v = 0x clamp` domain). |
| L7 archive (bitemporal) | Rust/WASM (parquet-wasm / Arrow) writer + R2 SQL indexing; TS envelope | Parquet encoding is a batch columnar task — perfect WASM (high fidelity, a proven wasm module). R2SQL (`SELECT` directly on Parquet, 2025-26) = read path needs no compute engine. |

The L3 "big one" ratified NOT to be a fork of any existing HNSW — it is re-derived (per §9),
Rust crates used only as compile-time evidence. L3's new monolithic WASM can be a Zed or
Rust module adding ~1-2 MiB Worker size (10 MiB budget) — fine.

**D7 — Zero-cost substrate mapped 1:1 onto Cloudflare primitives (research-backed, cut 2026-08-02).**
Reference architecture: Cloudflare's native primitives (Workers, Durable Objects, R2, D1, KV, Queues) run entirely on Cloudflare free tier — presigned R2 uploads, R2 object versioning as "history", KV/DO-SQLite for identity/claims, Workers static routes. PAI-Memory is the same architecture by construction (D1/D2/D6 already chose it). Everything below is Free-plan ($0/mo) for our scale:

| Primitive | Cloudflare FREE cap (2026, re-verified) | PAI-Memory use |
|---|---|---|
| Worker requests | 100,000/day | L1 in-isolate, thin API gate |
| Worker CPU | 10 ms/request (free) | **hard gate → must NOT host L3 build/encode here** |
| Durable Object | 100K req/day, ~13,000 GiB-s/day, **5 Mi written/day, 5 GiB stored, SQLite free 5 GiB** | L2/L3/L4 hot state + heavy-kernel home (DO has own CPU budget) |
| R2 | 10 GiB‑storage/mo, 1M Class-A, 10M Class-B ops, **$0 egress** | L7 archive + bitemporal versions, L5 hash-chain, Drive |
| R2 SQL (2025-26) | query Parquet server-side | L7 read path (no compute engine) |
| KV | 1 GiB, 100K reads/1K writes | ephemeral claims, TTL routing |
| D1 | 5 GiB, 5M/100K rows r/w | analytics elastic, spare |
| Queues | 10K ops/day | L6 handoff |
| Workers AI | free tier | embeddings (L2 f32/INT8) |
| Static Assets | 20K files, 25 MiB/file | `agent.json` discovery |

**The "CPU belongs in a DO" rule** (critical for L1/L3): Workers Free is 10 ms/request —
HNSW build, int8/Matryoshka embedding, Parquet encode all blow that. Those kernels run
INSIDE a Durable Object (its own 5-MiB-write, 13 K grups/day CPU envelope), the Worker
stays a thin gate. Free-tier caps become runtime-enforced construction budgets (D2), not
hopscotch — budgets surface exactly the caps.

**Cost honesty (Sidq/muraqaba):** "zero" is true inside daily caps (~100K writes/day, 5 GiB).
Past cap = tiers (~$5-20/mo) — design so a single tenant's memory stays inside caps by
construction; never ship a silent unbounded write path. R2 = the only unbounded-feeling
primitive: $0 egress, storage ~$0.015/GiB-mo.

---

## 13. Execution Contract (per the reality check)

Research is strong; execution must now catch up. Salient rules:

1. **Commit the spec BEFORE any code.** Spec-first is a merge gate, not a theory.
2. **Implement layer-by-layer, weekly** — L1 → L2 → L3 → L4 → L5 → L6 → L7. No layer is
   "done" until (a) unit tests pass, (b) benchmark exists, (c) it runs on Cloudflare Worker.
3. **No "done" claims** while code is prototype-shaped. The current `MemoryRouter.ts`
   (one `Map<string, MemoryEntry[]>` — effectively "table = memory") is the measured baseline
   gap, not the target.
4. Each layer needs a **working artifact** (test file with passing assertions), even inside
   the DO, before advancing.

---

*PAI-MEM — codename Momerino (internal). Spec v0.2. Ratified 2026-08-02.**

*D6 ratified 2026-08-02 (runtime & implementation language per layer).*