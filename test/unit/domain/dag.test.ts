import { describe, expect, it } from 'vitest';

import {
  DagCycleError,
  assertAcyclic,
  descendantCount,
  detectCycles,
  findDanglingDependencies,
  resolveActionable,
  toDagNodes,
} from '../../../src/domain/dag.js';
import type { DagNode } from '../../../src/domain/dag.js';
import type { TicketState } from '../../../src/domain/states.js';
import { makeTicket } from '../../helpers/notes.js';

const node = (id: string, depends_on: string[] = [], status: TicketState = 'backlog'): DagNode => ({
  id,
  status,
  depends_on,
});

const ids = (nodes: readonly DagNode[]): string[] => nodes.map((n) => n.id);

/**
 * Dependency errors are the failure mode that deadlocks the whole pipeline:
 * nothing crashes, nothing is actionable, and the loop spins forever.
 */
describe('resolveActionable', () => {
  it('a linear chain resolves one actionable ticket at a time', () => {
    const chain = [node('A'), node('B', ['A']), node('C', ['B'])];
    expect(ids(resolveActionable(chain))).toEqual(['A']);

    const aDone = [node('A', [], 'done'), node('B', ['A']), node('C', ['B'])];
    expect(ids(resolveActionable(aDone))).toEqual(['B']);

    const bDone = [node('A', [], 'done'), node('B', ['A'], 'done'), node('C', ['B'])];
    expect(ids(resolveActionable(bDone))).toEqual(['C']);
  });

  it('a diamond (A -> B, A -> C, B+C -> D) makes B and C actionable together', () => {
    const diamond = [
      node('A', [], 'done'),
      node('B', ['A']),
      node('C', ['A']),
      node('D', ['B', 'C']),
    ];
    expect(ids(resolveActionable(diamond))).toEqual(['B', 'C']);
  });

  it('a multi-parent ticket becomes actionable only when the last parent is done', () => {
    const oneParentDone = [
      node('A', [], 'done'),
      node('B', [], 'in_progress'),
      node('D', ['A', 'B']),
    ];
    expect(ids(resolveActionable(oneParentDone))).toEqual([]);

    const bothParentsDone = [
      node('A', [], 'done'),
      node('B', [], 'done'),
      node('D', ['A', 'B']),
    ];
    expect(ids(resolveActionable(bothParentsDone))).toEqual(['D']);
  });

  it('only considers tickets still in backlog', () => {
    const started = [node('A', [], 'in_progress'), node('B', [], 'done'), node('C')];
    expect(ids(resolveActionable(started))).toEqual(['C']);
  });

  it('treats a dependency on a nonexistent ticket as unsatisfied, never as satisfied', () => {
    expect(ids(resolveActionable([node('A', ['GHOST'])]))).toEqual([]);
  });

  it('returns results in deterministic id order regardless of input order', () => {
    const forward = [node('C'), node('A'), node('B')];
    expect(ids(resolveActionable(forward))).toEqual(['A', 'B', 'C']);
    expect(ids(resolveActionable([...forward].reverse()))).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate its input', () => {
    const input = [node('A'), node('B', ['A'])];
    const snapshot = JSON.stringify(input);
    resolveActionable(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('detectCycles', () => {
  it('detects a two-node cycle and names both nodes in the error', () => {
    const cyclic = [node('A', ['B']), node('B', ['A'])];
    expect(detectCycles(cyclic)).toHaveLength(1);

    let thrown: unknown;
    try {
      assertAcyclic(cyclic);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DagCycleError);
    const message = (thrown as DagCycleError).message;
    expect(message).toContain('A');
    expect(message).toContain('B');
    expect((thrown as DagCycleError).cycles[0]).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('detects a self-referencing depends_on', () => {
    const cycles = detectCycles([node('A', ['A'])]);
    expect(cycles).toEqual([['A']]);
    expect(() => assertAcyclic([node('A', ['A'])])).toThrow(DagCycleError);
    expect(() => assertAcyclic([node('A', ['A'])])).toThrow(/A/);
  });

  it('detects a three-node cycle', () => {
    const cycles = detectCycles([node('A', ['C']), node('B', ['A']), node('C', ['B'])]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
  });

  it('reports nothing for an acyclic graph, including a diamond', () => {
    expect(detectCycles([node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])])).toEqual([]);
    expect(() => assertAcyclic([node('A'), node('B', ['A'])])).not.toThrow();
  });

  it('is not confused by a dangling dependency', () => {
    expect(detectCycles([node('A', ['GHOST'])])).toEqual([]);
  });
});

describe('findDanglingDependencies', () => {
  it('reports a depends_on pointing at a nonexistent ticket ID rather than ignoring it', () => {
    const problems = findDanglingDependencies([node('A', ['GHOST', 'B']), node('B')]);
    expect(problems).toEqual([{ ticketId: 'A', missing: ['GHOST'] }]);
  });

  it('reports every missing id, sorted, for one ticket', () => {
    const problems = findDanglingDependencies([node('A', ['Z-GONE', 'A-GONE'])]);
    expect(problems).toEqual([{ ticketId: 'A', missing: ['A-GONE', 'Z-GONE'] }]);
  });

  it('reports nothing when every dependency resolves', () => {
    expect(findDanglingDependencies([node('A'), node('B', ['A'])])).toEqual([]);
  });

  it('treats a self-reference as resolvable, leaving it to cycle detection', () => {
    expect(findDanglingDependencies([node('A', ['A'])])).toEqual([]);
  });
});

describe('descendantCount', () => {
  it('on a diamond returns the transitive count, not the direct-child count', () => {
    const diamond = [node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])];
    // Direct children of A are B and C (2); transitively it also blocks D.
    expect(descendantCount(diamond, 'A')).toBe(3);
    expect(descendantCount(diamond, 'B')).toBe(1);
    expect(descendantCount(diamond, 'C')).toBe(1);
    expect(descendantCount(diamond, 'D')).toBe(0);
  });

  it('counts each descendant once even when reachable by several paths', () => {
    const wide = [
      node('A'),
      node('B', ['A']),
      node('C', ['A']),
      node('D', ['B', 'C']),
      node('E', ['D', 'B']),
    ];
    expect(descendantCount(wide, 'A')).toBe(4);
  });

  it('terminates on a cyclic graph instead of recursing forever', () => {
    const cyclic = [node('A', ['B']), node('B', ['A'])];
    expect(descendantCount(cyclic, 'A')).toBe(1);
  });

  it('throws on an unknown ticket id rather than silently returning 0', () => {
    expect(() => descendantCount([node('A')], 'GHOST')).toThrow(/GHOST/);
  });
});

describe('toDagNodes', () => {
  it('projects ticket notes onto the minimal shape the DAG functions need', () => {
    const nodes = toDagNodes([
      makeTicket({ id: 'FEAT-X-T001', status: 'backlog', depends_on: [] }),
      makeTicket({ id: 'FEAT-X-T002', status: 'ready', depends_on: ['FEAT-X-T001'] }),
    ]);
    expect(nodes).toEqual([
      { id: 'FEAT-X-T001', status: 'backlog', depends_on: [] },
      { id: 'FEAT-X-T002', status: 'ready', depends_on: ['FEAT-X-T001'] },
    ]);
  });
});
