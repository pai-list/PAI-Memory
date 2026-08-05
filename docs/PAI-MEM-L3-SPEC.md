# PAI-MEM L3 SPEC — Facts / Semantic Layer

> Codename Momerino (internal). Layer 3 of the 7-layer agent memory.
> Status: **ratified v0.1 — 2026-08-03**. Spec-first: code lands only after this merges (§13.1).

---

## 1. Purpose

L3 is the **facts / semantic** layer. It holds durable factual assertions extracted
from episodes (L2) and writes (trust-gate admission), and answers "what is true *now*"
— not "what was said most recently."

Topology: **navigable small-world** graph seeded by a **flat vector index first**,
with **validity edges** (fact-validity intervals after Zep/Graphiti). Numerics:
**INT8 + Matryoshka** cascade (§3). Decay: power-law `t^(−β)`, **β ≈ 0.8** by default.

The spec is honest about scope (Sidq): **HNSW is NOT assumed to win.** M3 of this
milestone measures flat vs HNSW at our real scale before any Rust/WASM is written
(D6 kill-rule).

---

## 2. Relation to Parent Spec

Implements of `docs/PAI-MEM-SPEC.md`:
- §3 **L3** row (facts / semantic; small-world + validity edges; INT8 + Matryoshka;
  0.5–2 GB; ms–tens ms; power-law β≈0.8).
- §4 numerics contract (one base embedding model; **L3-gold f32** / **L3-warm INT8** /
  **L3-sememe Matryoshka-256 + INT8**; always cascade; per-dim ±1σ calibration).
- §5 decay power-law + family score; §5.3 adaptive budget (per-layer, never global).
- §6 conflict / version / editing engine: **the clock decides, never the LLM**.
- §7 trust-gate admission (novelty/policy) on write.
- §12 **D2** (budgets per layer: L3 soft 100MB / hard 500MB),
  **D3** bitemporal (L3+ full — *staged here to light envelope first*),
  **D4** forget() tiered (L3 = **confirm**).
- §12 **D6** per-layer language: "L3 fact graph + HNSW → Rust→WASM SIMD kernel; TS
  glue" — *conditional on M3 benchmark*. Flat TS stays the shipped kernel until the
  numbers say otherwise.
- §12 **D7** zero-cost substrate: L3 runs inside a **Durable Object (SQLite-in-DO)**,
  Worker stays a thin gate.

---

## 2. Scope of THIS milestone (M0–M3)

| Decision | Choice | Rationale |
|---|---|---|
| Validity model | **Light envelope v1**: `factKey`, `serial`, `validFrom`, `validTo(null=forever)`, supersession by **max serial**. | Full bitemporal `txTime`/`txEnd` + edit/forgiveness audit table **deferred** to a later milestone (parent D3 "L3 = FULL valid + tx time" will not be reached this pass). Cheap now, backward-compatible later (D3 staged). |
| Index | **Flat TS matmul (Float32Array)** as the shipped recall path | D6 kill-rule: don't adopt HNSW/WASM until 3N-point benchmark says so. |
| Numerics | Matryoshka truncate to **256** (`mat256`) for first pass; **INT8** per-dim ±1σ for warm; **f32** exact rescore on the k-candidate set only | §4.2/§4.3, SMEC (arXiv:2510.12474) |
| Write gate | **SAGE-style novelty** `ADD \| NOOP \| MERGE` (deterministic vMF threshold via arithmetic) + trust-gate admission | §6, §7 |
| Budget | **soft 100 MB / hard 500 MB** ceiling, per-layer, enforces D2 | §2 |
| Overflow | `L3Overflow[]` carries `factKey`, `serial`, `embedding` (f32), `mat256`, `int8Params`, `reason` — **designed for M5 (L2→L3 promotion)** now | promotion/archive decision later |
| forget() | requires **`humanConfirm`** (L3 = long-term = data loss) | D4 |
| Full bitemporal | NOT implemented this milestone | D3 staged |

**Out of scope** (this pass): M4 (WASM HNSW kernel) and M5 (L2→L3 promotion wiring,
trust-gate novelty enforcement end-to-end). Both are gated on M3 numbers.

---

## 3. Light Bitemporal Envelope (valid on/near this milestone)

```
type FactRecord = {
  id: string;
  factKey: string;              // identity: (agent, canonical_key) — e.g. "alice:address"
  content: string;
  serial: number;               // monotonic issuer counter, NOT wall-clock (§6.3)
  validFrom: number;            // ms epoch — fact true-from
  validTo: number | null;       // ms epoch or null(= forever)
  embedding: Float32Array;       // full f32 (L3-gold, exact, rescore only)
  mat256: Float32Array;          // Matryoshka-256 truncated (primary first-pass)
  int8Params: Int8Array;         // INT8 warm form (per-dim ±1σ calibrated) + scales
  metadata: FactMetadata;
  novelty: 'ADD' | 'NOOP' | 'MERGE';
  createdAt: number;             // txn time (light)
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  pinned: boolean;
};
```

### 3.1 Resolution — the clock decides (§ six.3/6.4)
- On the same `factKey`, the fact with **highest `serial`** wins inside a valid window.
- **Equal serial + equal time + equal window** → **no win**: return both candidates
  with a `surface` marker (StateFuse-first). A contradiction is surfaced, never
  silently collapsed (matches `deterministic-resolver.ts` tie rule).
- **Freshness ≠ recency-priority**: a newer wall-clock entry does not outrank a later
  serial within the same valid window (§6.4). Relevance = `valid(now) ∧ max(serial) ∧
  policy-permitted`.

### 3.2 `valid(now)`
```
validityActive(rec, now) => rec.validFrom <= now AND (rec.validTo == null OR now <= rec.validTo)
```

---

## 4. Numerics Cascade (§4)

| Tier | Encoding | Bytes/vec @1024 | Use |
|------|----------|-----------------|-----|
| **L3-primary** | Matryoshka-256 + INT8 (per-dim ±1σ) | 256 B | first-pass similarity (the search kernel operates **here**) |
| **L3-warm** | INT8 (per-dim ±1σ) | 1 KB | fallback warm pass |
| **L3-gold** | f32 | 4 KB | final rescore of the k-size candidate set (never serve INT8 scores as final) |

Rules (immutable):
1. **Always cascade**: INT8/Matryoshka pass for recall, then **f32 rescore on the
   final candidate set**. Never serve INT8 scores as final scores on the user.
2. Quantization is **per-tier, configured, deterministic** — never silent. A test
   asserts Q-math reproducibility across platforms. `Clamp negative zero` rule:
   `val === 0 ? 0 : val` in every math function.
3. Sign / scale parameters: each INT8 vector stores **per-dim mean + scale (±1σ)**
   so dequant is exact-deterministic.

---

## 5. L3Overflow — designed for M5 now

```ts
interface L3Overflow {
  factKey: string;
  serial: number;
  embedding: Float32Array;   // full f32, never truncated (L3-gold)
  mat256: Float32Array;      // truncated form, re-insertable to L3/L4
  int8Params: Int8Array;     // plus mean/std metadata, compressed form
  reason: 'budget' | 'superseded' | 'expired';
  // M5 (L2→L3 promotion) consumes this shape: reason decides promote-vs-archive.
}
```
- `budget`   → promotion candidate (consolidate up).
- `superseded` → archiving candidate (kept for audit, not re-promoted).
- `expired`   → forgettability candidate (per D4, needs human confirm).

---

## 6. Decay (5.1/§5.2)
- Power-law `ret(t) = t^(−β)`, **default β = 0.8** for facts (spec §2/L3 row).
- `identity`, `commitment`, `decision`, `user_relevant` → near-zero β (≳64k h
  half-life); `rare` → fast; `generic` → default → v. The exact table mirrors
  `strings/DECAY_BETA` in L2 (extended with fact content types).
- `r(t) = w1·importance + w2·(1+accessScores)^γ · t^(−β) + w3·0.5^((t−last_access)/τ)`.

---

## 7. Write Path (trust gate)

1. **Validate** fact schema, origin, clocks, serial monotonicity.
2. **Score semantics-on-policy**: does this memory match current task + tenant?
3. **Novelty** (SAGE-style): `ADD` new / `NOOP` duplicate-similar / `MERGE` near-
   duplicate distinct serial.
4. **Budget**: over soft 100 MB → oldest unpinned to `L3Overflow` (promotion);
   hard 500 MB enforced (per-layer ceiling — never a global budget).
5. **Pin**: user/agent pin is never silently evicted (right-of-user).

---

## 7. API Surface v1

```
L3FactGraph (DO):
  upsert(rec: FactRecord): Promise<L3Outcome>        // apply gate + cascade + window
  recall(query, {validNow?, limit?, threshold?, filters?}): Promise<RankedFact[]>
  get(id): Promise<FactRecord | null>
  supersede(factKey, serial, newRec): Promise<L3Overflow[]>
  forget(id, reason, {humanConfirm}): Promise<boolean>   // requires human
  touch(id): Promise<boolean>
  choose(contentType, now, limit): Promise<Ranked[]>
  getStats(), setBudget(soft, hard)
  export(filters?), import(rows)
```

---

## 8. M3 — Kill-Rule Benchmark (deterministic gate)

**Measure end-to-end `recall()` inside the DO (Miniflare), not bare matmul.**
End-to-end includes: INT8 dequant + Matryoshka truncate + power-law scoring +
validity SQL filtering. A DO is single-threaded with a CPU envelope; the gate is
about the whole pipeline, not the kernel alone.

Points (scaling curve — one threshold is a floor, not a ceiling):

| N | label |
|----|-------|
| 10_000 | current dataset |
| 50_000 | projected 6-month growth |
| 100_000 | stress test |

**Kill-Rule Decision Matrix** (primary gate at N=10k, d=256; curve tells the trend):

| Flat-TS p95 latency @10k,d=256 | Decision |
|-------------------------------|----------|
| **< 5 ms**                     | **SKIP WASM** — ship flat (D6 satisfied: HNSW does not measurably win) |
| **5–20 ms**                    | **Profile first**: is it I/O-bound (SQL/filter) or CPU-bound (matmul)? Optimize the bottleneck before any WASM investment |
| **> 20 ms**                    | **M4**: re-derive a WASM-HNSW HNSW kernel (§9 — not a fork) and re-measure |

The 50k/100k columns gate *timing*: if 10k is ≤5ms but 50k is 35ms, then WASM is
inevitable — you've only bought time; schedule M4 with a target date.

Benchmarks also: recall@10 (top-10 correctness vs gold), dequant amplification
(bytes pushed through pipeline), and CPU-envelope headroom (measured): (DO CPU
limit ~50 ms/req; keep ≤50% = ~25 ms).

---

## 9. Sources / Research Basis

- Matsuite (main spec) — `docs/PAI-MEM-SPEC.md` (ratified 2026-08-03).
- SMEC: Sequential Matryoshka Embedding Compression — arXiv:2510.12474 / EMNLP 2025
  (worker: truncation-aware ADS beats naive truncation at 256d; +1.1/+2.7 nDCG@10 BEIR).
- Matryoshka## Representation Learning — Kusupati+2022 (arXiv:2205.13147).
- Zep/Graphiti — temporal KG + validity intervals.
- "Prune the LLM to track freshness" — arXiv:2606.01435 (max-serial >> LLM).
- altor-vec (Rust HNSW→54KB WASM, sub-ms@10k; boundary-rule reference) —
  compile-time evidence only, per MF for "re-derived, not forked" (§9).
- VecLite (Rust/WASM+SIMD flat): flat > HNSW at 1536d up to 100k (multiple 2026
  independent measurements) — the reason v asks the flat kernel into the bench.

---

## 10. Tests (minimum gate)

1. **Determinism of supersession**: max-serial wins; equal-serial tie → `surface`
   (no collapse).
2. **Superseded-by-serial excluded from recall**.
3. **Null `validTo` alive**: open windows returned.
4. **Expired window excluded from recall / becomes overflow `expired`**.
5. **Matryoshka truncate** → exactly 256 dims; **INT8 quantize** → INT8 exact,
   per-dim ±σ, clamped negative zero; rescorefloat read round-trip.
6. **Power-law** β=0.8 curve + identity→near-zero.
7. **Budget**: soft eviction → `L3Overflow[]` (pinned survive; hard ceiling never
   exceeded).
8. **Novelty** gate classification ADD / NOOP / MERGE deterministic.
9. **forget requires humanConfirm**.
10. **Benchmark gate** water-test asserts measured N=10k latency < stale→ fail loud.

---

*PAI-MEM-L3 v1 (codename Momerino) · Spec committed before code (§13.1) · ratified 2026-08-03.*