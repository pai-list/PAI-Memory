/**
 * PAI-Memory L4 Code-Graph Kernel Tests
 *
 * Verifies the in-memory L4CodeGraph against PAI-MEM-L4-SPEC.md:
 *  - exact short-circuit index (§4.3) — resolve is a Map hit, no embedding
 *  - dendritic topology: modules -> files -> symbols + typed call edges
 *  - light versioning envelope: supersede by MAX serial (the clock decides)
 *  - near-persist decay (β = 0.01 identity tier)
 *  - D4: forget() requires humanConfirm + impact list
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  L4CodeGraph, powerDecay, familyScore,
  L4_SOFT_BUDGET_BYTES, L4_HARD_CEILING_BYTES, L4_DEFAULT_BETA,
} from './l4-code-graph';

describe('L4CodeGraph kernel', () => {
  let graph: L4CodeGraph;

  beforeEach(() => {
    graph = new L4CodeGraph();
  });

  describe('addSymbol + exact resolution', () => {
    it('adds a symbol and resolves it exactly (Map hit, no embedding)', () => {
      const status = graph.addSymbol({
        qualifiedName: 'apt.pay.submitInvoice',
        kind: 'function',
        file: 'pay.ts',
        module: 'apt',
        deps: ['apt.escrow.hold'],
      });
      expect(status).toBe('ADDED');
      const r = graph.resolve('apt.pay.submitInvoice');
      expect(r).toBeDefined();
      expect(r!.file).toBe('pay.ts');
      expect(r!.module).toBe('apt');
      expect(r!.deps).toEqual(['apt.escrow.hold']);
    });

    it('returns undefined for unknown symbols', () => {
      expect(graph.resolve('nope.missing')).toBeUndefined();
    });

    it('increments access count on resolve (recency signal)', () => {
      graph.addSymbol({ qualifiedName: 'a.b' });
      graph.resolve('a.b');
      graph.resolve('a.b');
      const r = graph.resolve('a.b');
      expect(r!.accessCount).toBe(3);
    });
  });

  describe('dendritic call-graph', () => {
    it('tracks modules -> files -> symbols in fileTree()', () => {
      graph.addSymbol({ qualifiedName: 'a.pay.submit', file: 'pay.ts', module: 'a' });
      graph.addSymbol({ qualifiedName: 'a.pay.refund', file: 'pay.ts', module: 'a' });
      graph.addSymbol({ qualifiedName: 'b.escrow.hold', file: 'escrow.ts', module: 'b' });

      const tree = graph.fileTree();
      expect(tree['a']['pay.ts']).toEqual(['a.pay.submit', 'a.pay.refund']);
      expect(tree['b']['escrow.ts']).toEqual(['b.escrow.hold']);
    });

    it('links callers and callees (related)', () => {
      graph.addSymbol({ qualifiedName: 'pay.submit', deps: ['escrow.hold', 'ledger.write'] });
      graph.addSymbol({ qualifiedName: 'escrow.hold' });
      graph.addSymbol({ qualifiedName: 'ledger.write' });

      expect(graph.related('escrow.hold').callers).toContain('pay.submit');
      expect(graph.related('pay.submit').callees).toEqual(['escrow.hold', 'ledger.write']);
    });

    it('computes dendritic depth', () => {
      graph.addSymbol({ qualifiedName: 'main' });
      graph.addSymbol({ qualifiedName: 'lib.b', deps: ['lib.c'] });
      graph.addSymbol({ qualifiedName: 'lib.c' });
      graph.addSymbol({ qualifiedName: 'main', deps: ['lib.b'] });
      // main -> lib.b -> lib.c  => depth 2
      expect(graph.related('lib.b').depth).toBe(1);
      expect(graph.related('main').depth).toBe(2);
      expect(graph.related('nope').depth).toBe(-1);
    });
  });

  describe('versioning envelope (the clock decides)', () => {
    it('supersedes by MAX serial, closing the prior window', () => {
      const v1 = graph.addSymbol({ qualifiedName: 'x.y', validFrom: 100 });
      const v2 = graph.addSymbol({ qualifiedName: 'x.y', validFrom: 200 });
      expect(v1).toBe('ADDED');
      expect(v2).toBe('VERSIONED');

      const current = graph.resolve('x.y');
      expect(current!.validFrom).toBe(200);
      expect(current!.validTo).toBeNull();
    });

    it('name map holds only current version', () => {
      graph.addSymbol({ qualifiedName: 'x.y', validFrom: 100 });
      graph.addSymbol({ qualifiedName: 'x.y', validFrom: 200 });
      expect(graph.totalSymbols).toBe(1);
    });
  });

  describe('D2 budget + near-persist decay', () => {
    it('defines soft=50MiB, hard=200MiB, beta=0.01', () => {
      expect(L4_SOFT_BUDGET_BYTES).toBe(50 * 1024 * 1024);
      expect(L4_HARD_CEILING_BYTES).toBe(200 * 1024 * 1024);
      expect(L4_DEFAULT_BETA).toBe(0.01);
    });

    it('decays slowly — near-persist: 30 days barely hurts vs 1 day', () => {
      const oneDay = powerDecay(86_400_000);
      const thirtyDays = powerDecay(30 * 86_400_000);
      expect(oneDay).toBeCloseTo(1.0, 2);
      expect(thirtyDays).toBeCloseTo(0.966, 2);
      expect(oneDay - thirtyDays).toBeLessThan(0.1); // near-persist
    });

    it('ranks heavier-symbol families higher at same age', () => {
      const lo = familyScore(0.2, 1, 0);
      const hi = familyScore(0.9, 1, 0);
      expect(hi).toBeGreaterThan(lo);
    });
  });

  describe('forget() (D4 confirm)', () => {
    it('throws without humanConfirm', () => {
      graph.addSymbol({ qualifiedName: 'pay.submit' });
      expect(() =>
        graph.forget({ qualifiedName: 'pay.submit', humanConfirm: false, reason: 'test' }),
      ).toThrow(/humanConfirm/);
    });

    it('removes and reports impact (callers/callees) when confirmed', () => {
      graph.addSymbol({ qualifiedName: 'pay.submit', deps: ['escrow.hold'] });
      graph.addSymbol({ qualifiedName: 'escrow.hold' });

      const res = graph.forget({ qualifiedName: 'escrow.hold', humanConfirm: true, reason: 'owner review' });
      expect(res.removed).toBe(true);
      expect(res.impact).toContain('pay.submit'); // caller loses its callee
      expect(graph.resolve('escrow.hold')).toBeUndefined();
    });

    it('reports no-op for unknown symbol', () => {
      const res = graph.forget({ qualifiedName: 'nope', humanConfirm: true, reason: 'x' });
      expect(res.removed).toBe(false);
      expect(res.impact).toEqual([]);
    });
  });
});