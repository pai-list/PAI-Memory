/**
 * PAI-Memory L4 Procedural/Code Core (in-memory kernel)
 *
 * Spec: docs/PAI-MEM-L4-SPEC.md §1–§5. Parent: docs/PAI-MEM-SPEC.md §3 (L4),
 * §4.3 index by topology, §5 decay, §6 the clock decides, D2/D3/D4, D6.
 *
 * Milestone scope (M0–M3, exact-index-first):
 *   - Primary path = EXACT short-circuit: Map lookups by qualifiedName, file,
 *     module. NO embedding dependency. Code identity is exact.
 *   - Dendritic call-graph: modules -> files -> symbols, typed call edges.
 *   - Light versioning envelope: qualifiedName + serial + validFrom/validTo,
 *     supersede by MAX serial (the clock decides).
 *   - Near-persist decay: β = 0.01 identity-tier default.
 *   - D2 per-layer budget: soft 50MiB / hard 200MiB. Overflow -> L4Overflow[].
 *   - D4 forget(): requires humanConfirm + impact list (callers/callees).
 *   - INT8/Matryoshka reserved for a semantic fallback (Vectorize) — not here.
 */

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const L4_SOFT_BUDGET_BYTES = 50 * 1024 * 1024; // D2: 50 MiB soft
export const L4_HARD_CEILING_BYTES = 200 * 1024 * 1024; // D2: 200 MiB hard ceiling
export const L4_DEFAULT_BETA = 0.01; // near-persist (identity-tier, §5.1)

export type CodeSymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'const'
  | 'file' | 'module';

export type L4OverflowReason = 'budget' | 'superseded' | 'expired';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SymbolRecord {
  id: string;                 // uuid (per version)
  qualifiedName: string;      // e.g. "apt.pay.submitInvoice"
  kind: CodeSymbolKind;
  module: string;             // package/module name
  file: string;               // relative path
  signature?: string;
  serial: number;
  validFrom: number;          // release ts (valid time)
  validTo: number | null;     // null = forever
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  importanceScore: number;
  layer: string;              // MemoryLayer.L4_CODE
  tier: string;               // MemoryTier.COOL
  pinned: boolean;            // survives soft-budget overflow
  deps: string[];             // out-edges (calls to / imports of)
  dependents: string[];       // in-edges (who calls / imports me)
}

export interface SymbolInput {
  qualifiedName: string;
  kind?: CodeSymbolKind;
  file?: string;
  module?: string;
  signature?: string;
  deps?: string[];
  importanceScore?: number;
  validFrom?: number;
}

export interface L4Overflow {
  qualifiedName: string;
  serial: number;
  reason: L4OverflowReason;
}

export interface ForgetRequest {
  qualifiedName: string;
  humanConfirm: boolean;      // REQUIRED (D4)
  reason: string;
}

// ─────────────────────────────────────────────
// Kernel
// ─────────────────────────────────────────────

let __serial = 0;
const nextSerial = () => ++__serial;

export class L4CodeGraph {
  private byName = new Map<string, SymbolRecord>();
  private byFile = new Map<string, SymbolRecord[]>();
  private byModule = new Map<string, SymbolRecord[]>();
  private pendingEdges = new Map<string, string[]>(); // callee -> callers, for late-arriving callees
  private overflow: L4Overflow[] = [];

  get sizeBytes(): number {
    let bytes = 0;
    for (const s of this.byName.values()) {
      bytes += s.qualifiedName.length * 2 + (s.signature?.length ?? 0) * 2 + s.file.length * 2;
    }
    return bytes;
  }

  get totalSymbols(): number { return this.byName.size; }

  /** ADDED | VERSIONED | NOOP — supersede by MAX serial within same window. */
  addSymbol(input: SymbolInput): 'ADDED' | 'VERSIONED' | 'NOOP' {
    const { qualifiedName } = input;
    const existing = this.byName.get(qualifiedName);
    const serial = nextSerial();
    const record: SymbolRecord = {
      id: `${qualifiedName}@${serial}`,
      qualifiedName,
      kind: input.kind ?? 'function',
      file: input.file ?? '',
      module: input.module ?? '',
      signature: input.signature ?? qualifiedName,
      serial,
      validFrom: input.validFrom ?? Date.now(),
      validTo: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: 0,
      importanceScore: input.importanceScore ?? 0.5,
      layer: 'L4_CODE',
      tier: 'COOL',
      pinned: false,
      deps: input.deps ?? [],
      dependents: [],
    };

    if (!existing) {
      this.byName.set(qualifiedName, record);
      this.indexByGroup(record);
      this.linkEdges(record);
      return 'ADDED';
    }

    // same window, newer serial supersedes (clock decides)
    if (existing.serial < serial) {
      existing.validTo = record.validFrom; // old version ends when new version starts
      this.byName.set(qualifiedName, record);
      this.indexByGroup(record);
      this.linkEdges(record);
      return 'VERSIONED';
    }
    return 'NOOP';
  }

  private indexByGroup(r: SymbolRecord) {
    const byFile = this.byFile.get(r.file) ?? [];
    byFile.push(r);
    this.byFile.set(r.file, byFile);

    const byModule = this.byModule.get(r.module) ?? [];
    byModule.push(r);
    this.byModule.set(r.module, byModule);
  }

  private linkEdges(r: SymbolRecord) {
    for (const dep of r.deps) {
      const d = this.byName.get(dep);
      if (d) {
        if (!d.dependents.includes(r.qualifiedName)) {
          d.dependents.push(r.qualifiedName);
        }
      } else {
        // callee not indexed yet — remember so a later addSymbol links both ways
        const callers = this.pendingEdges.get(dep) ?? [];
        if (!callers.includes(r.qualifiedName)) callers.push(r.qualifiedName);
        this.pendingEdges.set(dep, callers);
      }
    }
    // backfill: any pending edge where THIS symbol is the callee
    const waiting = this.pendingEdges.get(r.qualifiedName);
    if (waiting) {
      for (const caller of waiting) {
        if (!r.dependents.includes(caller)) r.dependents.push(caller);
      }
      this.pendingEdges.delete(r.qualifiedName);
    }
  }

  /** Exact resolution (primary path). Supersede-by-serial already applied to name map. */
  resolve(name: string): SymbolRecord | undefined {
    const r = this.byName.get(name);
    if (r) {
      r.accessCount += 1;
      r.lastAccessedAt = Date.now();
    }
    return r;
  }

  /** Callers + callees + symbolic depth (dendritic). */
  related(name: string): { callers: string[]; callees: string[]; depth: number } {
    const r = this.resolve(name);
    if (!r) return { callers: [], callees: [], depth: -1 };
    return { callers: r.dependents, callees: r.deps, depth: this.depth(r) };
  }

  private depth(r: SymbolRecord, seen = new Set<string>()): number {
    if (seen.has(r.qualifiedName)) return 0;
    seen.add(r.qualifiedName);
    let max = 0;
    for (const d of r.deps) {
      const dep = this.byName.get(d);
      if (dep) max = Math.max(max, 1 + this.depth(dep, seen));
    }
    return max;
  }

  /** Dendritic tree: modules -> files -> symbols. */
  fileTree(): Record<string, Record<string, string[]>> {
    const tree: Record<string, Record<string, string[]>> = {};
    for (const r of this.byName.values()) {
      (tree[r.module] ??= {})[r.file] ??= [];
      tree[r.module][r.file].push(r.qualifiedName);
    }
    return tree;
  }

  /** D4: dependency-aware forget. Must be human-confirmed. */
  forget(req: ForgetRequest): { removed: boolean; impact: string[] } {
    if (!req.humanConfirm) throw new Error('L4 forget() requires humanConfirm (D4)');
    const r = this.byName.get(req.qualifiedName);
    if (!r) return { removed: false, impact: [] };
    const impact = [...r.dependents, ...r.deps].filter((n) => n !== req.qualifiedName);
    this.byName.delete(r.qualifiedName);
    const fileArr = this.byFile.get(r.file);
    if (fileArr) {
      const idx = fileArr.indexOf(r);
      if (idx !== -1) fileArr.splice(idx, 1);
    }
    const moduleArr = this.byModule.get(r.module);
    if (moduleArr) {
      const idx = moduleArr.indexOf(r);
      if (idx !== -1) moduleArr.splice(idx, 1);
    }
    this.overflow.push({ qualifiedName: req.qualifiedName, serial: r.serial, reason: 'superseded' });
    return { removed: true, impact };
  }

  getOverflow(): L4Overflow[] { return this.overflow; }
}

// ─────────────────────────────────────────────
// Decay & score (near-persist)
// ─────────────────────────────────────────────

export function powerDecay(tMs: number, beta = L4_DEFAULT_BETA): number {
  const days = Math.max(tMs, 1) / 86_400_000;
  return Math.pow(days, -beta);
}

export function familyScore(
  importance: number,
  accesses: number,
  ageMs: number,
  beta = L4_DEFAULT_BETA,
  tauMs = 30 * 86_400_000,
): number {
  const a = 0.4 * importance;
  const b = 0.3 * (1 + accesses) * powerDecay(ageMs, beta);
  const c = 0.3 * Math.pow(0.5, ageMs / tauMs);
  return a + b + c;
}

// ─────────────────────────────────────────────
// Self-check (ponytail: one runnable `assert` demo)
// ─────────────────────────────────────────────

export function demo() {
  const g = new L4CodeGraph();
  g.addSymbol({ qualifiedName: 'apt.pay.submit', file: 'pay.ts', module: 'apt', deps: ['apt.escrow.hold'] });
  g.addSymbol({ qualifiedName: 'apt.escrow.hold', file: 'escrow.ts', module: 'apt' });
  const first = g.resolve('apt.pay.submit')!;
  const related = g.related('apt.pay.submit');
  const tree = g.fileTree();

  if (related.callers.length !== 0) throw new Error('dendritic: submit has no callers yet');
  if (related.callees[0] !== 'apt.escrow.hold') throw new Error('dendritic: submit -> escrow.hold missing');
  if (g.resolve('apt.escrow.hold')!.dependents[0] !== 'apt.pay.submit') throw new Error('dendritic: escrow.hold in-edge missing');
  if (!('apt' in tree) || !(tree.apt['pay.ts']?.includes('apt.pay.submit') ?? false)) throw new Error('dendritic: file tree broken');

  const versioned = g.addSymbol({ qualifiedName: 'apt.pay.submit' });
  if (versioned === 'NOOP') throw new Error('clock: newer serial must supersede');
  if (first.validTo === null) throw new Error('clock: old version must gain validTo end');
}
