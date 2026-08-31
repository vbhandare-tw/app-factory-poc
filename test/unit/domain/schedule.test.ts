import { describe, expect, it } from 'vitest';

import {
  STAGE_PRIORITY,
  compareWorkItems,
  rankWorkItems,
  stagePriority,
} from '../../../src/domain/schedule.js';
import type { WorkItem } from '../../../src/domain/schedule.js';
import { ALL_FEATURE_STATES, TICKET_STATES } from '../../../src/domain/states.js';

const item = (id: string, stage: WorkItem['stage']): WorkItem => ({ id, stage });

/**
 * Guards M4 against silent regressions. M1–M3 implements requirements §8.1
 * rule 1 (stage priority) and rule 5 (lexicographic tiebreaker) only.
 */
describe('stage priority (requirements §8.1 rule 1)', () => {
  it('orders merge > qa > code_review > in_progress > ready > ticketing > planning > refining', () => {
    const declared = [
      'merge',
      'qa',
      'code_review',
      'in_progress',
      'ready',
      'ticketing',
      'planning',
      'refining',
    ] as const;

    for (let i = 0; i < declared.length - 1; i += 1) {
      const higher = declared[i]!;
      const lower = declared[i + 1]!;
      expect(
        stagePriority(higher),
        `${higher} must outrank ${lower}`,
      ).toBeLessThan(stagePriority(lower));
      expect(compareWorkItems(item('B', higher), item('A', lower))).toBeLessThan(0);
      expect(compareWorkItems(item('A', lower), item('B', higher))).toBeGreaterThan(0);
    }
  });

  it('keeps regression between merge and qa, as requirements §8.1 spells out', () => {
    expect(stagePriority('merge')).toBeLessThan(stagePriority('regression'));
    expect(stagePriority('regression')).toBeLessThan(stagePriority('qa'));
  });

  it('assigns a priority to every declared feature and ticket state', () => {
    for (const state of [...ALL_FEATURE_STATES, ...TICKET_STATES]) {
      expect(Number.isInteger(STAGE_PRIORITY[state]), `${state} has no priority`).toBe(true);
    }
  });

  it('ranks done and needs_human below every workable stage', () => {
    const workable = ['merge', 'qa', 'code_review', 'in_progress', 'ready', 'backlog'] as const;
    for (const stage of workable) {
      expect(stagePriority(stage)).toBeLessThan(stagePriority('needs_human'));
      expect(stagePriority(stage)).toBeLessThan(stagePriority('done'));
    }
  });
});

describe('lexicographic tiebreaker (requirements §8.1 rule 5)', () => {
  it('equal stages fall back to lexicographic ticket ID', () => {
    expect(compareWorkItems(item('FEAT-A-T001', 'ready'), item('FEAT-A-T002', 'ready'))).toBeLessThan(0);
    expect(compareWorkItems(item('FEAT-A-T002', 'ready'), item('FEAT-A-T001', 'ready'))).toBeGreaterThan(0);
    expect(compareWorkItems(item('FEAT-A-T001', 'ready'), item('FEAT-A-T001', 'ready'))).toBe(0);
  });

  it('uses codepoint order, not locale collation, so the result is machine-independent', () => {
    // 'Z' < 'a' by codepoint; several locales say otherwise.
    expect(compareWorkItems(item('Z', 'ready'), item('a', 'ready'))).toBeLessThan(0);
  });
});

describe('determinism (plan Section E item 10)', () => {
  const snapshot: WorkItem[] = [
    item('FEAT-B-T002', 'ready'),
    item('FEAT-A-T004', 'merge'),
    item('FEAT-A-T001', 'ready'),
    item('FEAT-C-T009', 'qa'),
    item('FEAT-A-T003', 'code_review'),
    item('FEAT-B-T001', 'in_progress'),
    item('FEAT-D', 'planning'),
    item('FEAT-E', 'refining'),
  ];

  it('sorting an array twice yields identical order', () => {
    const once = rankWorkItems(snapshot);
    const twice = rankWorkItems(once);
    expect(twice.map((w) => w.id)).toEqual(once.map((w) => w.id));
  });

  it('ranking is independent of input order', () => {
    const shuffled = [...snapshot].reverse();
    expect(rankWorkItems(shuffled).map((w) => w.id)).toEqual(
      rankWorkItems(snapshot).map((w) => w.id),
    );
  });

  it('produces the expected full ranking for a mixed snapshot', () => {
    expect(rankWorkItems(snapshot).map((w) => w.id)).toEqual([
      'FEAT-A-T004', // merge
      'FEAT-C-T009', // qa
      'FEAT-A-T003', // code_review
      'FEAT-B-T001', // in_progress
      'FEAT-A-T001', // ready, lexicographically first
      'FEAT-B-T002', // ready
      'FEAT-D', // planning
      'FEAT-E', // refining
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [...snapshot];
    rankWorkItems(input);
    expect(input.map((w) => w.id)).toEqual(snapshot.map((w) => w.id));
  });
});

// ---------------------------------------------------------------------------
// M4 placeholders. These rules are specified in requirements §8.1 but are out
// of scope for M1–M3 (plan Phase 2). They are written as skipped blocks so the
// gap is visible in the test output rather than only in a document.
//
// Note on numbering: the plan says "rules 2–5". Rule 5 (lexicographic
// tiebreaker) is in fact implemented now — see the block above. What is
// actually deferred is rules 2, 3, 4 and the starvation guard.
// ---------------------------------------------------------------------------

describe.skip('M4 — requirements §8.1 rule 2: fixes before new work', () => {
  it('a ticket with attempts > 0 outranks a fresh ready ticket at the same stage', () => {
    throw new Error('not implemented until M4');
  });
});

describe.skip('M4 — requirements §8.1 rule 3: feature priority and focus', () => {
  it('orders features high > medium > low, then FIFO by created_at', () => {
    throw new Error('not implemented until M4');
  });

  it('hides tickets of a non-active feature once max_active_features is reached', () => {
    throw new Error('not implemented until M4');
  });

  it('makes blocked features invisible to the scheduler', () => {
    throw new Error('not implemented until M4');
  });
});

describe.skip('M4 — requirements §8.1 rule 4: critical path within a feature', () => {
  it('among sibling ready tickets, the higher DAG descendant count wins', () => {
    // descendantCount() already exists and is tested in dag.test.ts; only the
    // wiring into compareWorkItems is deferred.
    throw new Error('not implemented until M4');
  });
});

describe.skip('M4 — requirements §8.1 starvation guard', () => {
  it('boosts an item waiting longer than config.max_wait to the top of its stage', () => {
    throw new Error('not implemented until M4');
  });
});
