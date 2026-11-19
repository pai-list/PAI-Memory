# PAI-MEM L4 SPEC — Procedural / Code Layer

> Codename Momerino (internal). Layer 4 of the 7-layer agent memory.
> Status: **ratified v0.1 — 2026-08-07**. Spec-first: code lands only after this merges (§13.1).

---

## 1. Purpose

L4 is the **procedural / code** layer. It holds the org's *how*: call graphs,
symbol/file/module hierarchies, and AST hooks — the memory an agent needs to
answer "what touches what, and how do I change it safely" for any repo.

Topology: **call-graph (dendritic)** — modules → files → symbols, with typed
call edges and exact lookup as the primary index. Numerics: code-aware
(symbol-exact + INT8/Matryoshka only when semantic recall is needed). Decay:
**very low (near-persist)** — code facts outlive conversation.

The spec is honest (Sidq): **exact index wins at this layer.** Code identity
is exact (`qualified_name`), so lookup is a Map hit, not a vector search.
Embeddings are the *fallback* for "similar to X" — never the primary path
(spec §4.3: inverted + code-attribute index, exact short-circuit).

---

## 2. Relation to Parent Spec

Implements `docs/PAI-MEM-SPEC.md`:
- §3 **L4** row (procedural/code; call-graph dendritic + AST hooks;
  INT8 + Matryoshka + code-aware; 1–5 GB; ms; near-persist).
- §4.3 index by topology: L4 = inverted + code-attribute
  (symbol/file/module/git) — exact short-circuit.
- §5 decay: L4 near-zero (β table mirrors identity tier).
- §6 the clock decides: version = valid time (release); supersede by serial.
- §12 **D2** budgets (L4 soft 50MB / hard 200MB), **D3** bitemporal FULL
  (code: version = valid time, release = window), **D4** forget() = **confirm**
  (show impact: "deleting code-scope breaks agents"), **D6** language: TS core
  (tree-sitter sidecar Worker for AST when parsing is needed — deferred).

---

## 3. Scope of THIS milestone (M0–M3)

| Decision | Choice | Rationale |
|---|---|---|
| Index | **Exact short-circuit first**: Map by `qualifiedName`, `file`, `module`; call-edge index; **no embedding dependency** for the primary path | §4.3 — code is exact; vector only as semantic fallback |
| Versioning | Light envelope: `qualifiedName` + `serial` + `validFrom/validTo(null=∞)` (release = valid time), supersede by max serial | D3 staged like L3 |
| AST hooks | Ingest accepts pre-parsed node summaries `{ name, kind, file, range, deps }` — the tree-sitter sidecar Worker feeds these; core stores, never parses | D6: sidecar via RPC when needed |
| Decay | Near-persist: β = 0.01 identity-tier default | §5.1 — code memory must survive |
| Budget | soft 50 MiB / hard 200 MiB (D2 L4 row) | per-layer, never global |
| forget() | requires `humanConfirm` + impact list (callers/callees broken) | D4: L4 = confirm |
| Numerics | INT8/Matryoshka **reserved** for semantic fallback (not shipped this pass) | semantic recall → later milestone with Vectorize |

**Out of scope** (this pass): tree-sitter parsing (sidecar), embedding
semantic fallback (Vectorize), L3→L4 promotion wiring.

---

## 4. API Surface

```
l4-code-graph.ts (kernel):
  addSymbol(sym)      -> { status: 'ADDED' | 'VERSIONED' | 'NOOP' }
  addCall(caller, callee)
  resolve(name)       -> SymbolRecord[] (exact, supersede-by-serial)
  related(name)       -> { callers, callees, depth }
  fileTree(module?)   -> modules -> files -> symbols (dendritic)
  forget(name, humanConfirm) -> { removed, impact: string[] }
  recall(text)        -> exact-match only (primary path)

l4-do-adapter.ts (DO + SQLite):
  tables: l4_symbols · l4_calls · l4_files
  budget: soft 50 MiB / hard 200 MiB (D2)
```

---

## 5. Edge Maintenance (§5.5)

Edges are memory too: each call edge gets `createdAt`, `serial`,
`validFrom/validTo`. Retaining an edge without its validity window is a
coherence trap — call edges die with their symbol version.

---

*PAI-MEM — codename Momerino (internal). Spec v0.1. Ratified 2026-08-07.*
