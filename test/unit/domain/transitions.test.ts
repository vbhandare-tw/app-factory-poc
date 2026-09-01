import { describe, expect, it } from 'vitest';

import {
  allDependenciesDone,
  allTicketsDone,
  attemptsRemaining,
  gatesAllGreen,
  mergeVerified,
} from '../../../src/domain/guards.js';
import { ALL_FEATURE_STATES, TICKET_STATES } from '../../../src/domain/states.js';
import type { FeatureState, TicketState } from '../../../src/domain/states.js';
import {
  FEATURE_TRANSITIONS,
  HISTORY_HEADING,
  TICKET_TRANSITIONS,
  TransitionError,
  appendHistoryLine,
  applyTransition,
  canTransition,
  formatHistoryLine,
  historyLines,
} from '../../../src/domain/transitions.js';
import { deepFreeze, gateResult, greenGates, makeFeature, makeTicket } from '../../helpers/notes.js';

const NOW = '2026-02-02T12:00:00Z';

/**
 * The state machine is the system's rulebook. An illegal transition that slips
 * through corrupts the vault silently — nothing throws, the note just says
 * something that cannot be true.
 */
describe('TICKET_TRANSITIONS — table shape', () => {
  it('every rule is reachable from backlog (no orphan rules)', () => {
    const reachable = new Set<TicketState>(['backlog']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of TICKET_TRANSITIONS) {
        if (reachable.has(rule.from) && !reachable.has(rule.to)) {
          reachable.add(rule.to);
          grew = true;
        }
      }
    }

    const orphans = TICKET_TRANSITIONS.filter((rule) => !reachable.has(rule.from));
    expect(
      orphans.map((rule) => `${rule.from} -> ${rule.to}`),
      'these rules can never fire because their `from` state is unreachable',
    ).toEqual([]);
  });

  it('reaches every declared ticket state from backlog', () => {
    const reachable = new Set<TicketState>(['backlog']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of TICKET_TRANSITIONS) {
        if (reachable.has(rule.from) && !reachable.has(rule.to)) {
          reachable.add(rule.to);
          grew = true;
        }
      }
    }
    expect([...TICKET_STATES].filter((s) => !reachable.has(s))).toEqual([]);
  });

  it('declares no self-transition and no duplicate (from, to, actor) rule', () => {
    const seen = new Set<string>();
    for (const rule of TICKET_TRANSITIONS) {
      expect(rule.from).not.toBe(rule.to);
      for (const actor of rule.actors) {
        const key = `${rule.from}->${rule.to}:${actor}`;
        expect(seen.has(key), `duplicate rule ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('lists at least one actor for every rule', () => {
    for (const rule of TICKET_TRANSITIONS) {
      expect(rule.actors.length, `${rule.from} -> ${rule.to} has no actor`).toBeGreaterThan(0);
    }
  });
});

describe('backlog -> ready', () => {
  it('is refused when any dependency is not done', () => {
    const ticket = makeTicket({ id: 'T3', depends_on: ['T1', 'T2'] });
    const siblings = [
      makeTicket({ id: 'T1', status: 'done' }),
      makeTicket({ id: 'T2', status: 'qa' }),
      ticket,
    ];
    const result = canTransition(ticket, 'ready', 'orchestrator', { tickets: siblings });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('T2');
  });

  it('is allowed when all dependencies are done', () => {
    const ticket = makeTicket({ id: 'T3', depends_on: ['T1', 'T2'] });
    const siblings = [
      makeTicket({ id: 'T1', status: 'done' }),
      makeTicket({ id: 'T2', status: 'done' }),
      ticket,
    ];
    expect(canTransition(ticket, 'ready', 'orchestrator', { tickets: siblings }).ok).toBe(true);
  });

  it('is allowed with no dependencies at all', () => {
    const ticket = makeTicket({ id: 'T1' });
    expect(canTransition(ticket, 'ready', 'orchestrator', { tickets: [ticket] }).ok).toBe(true);
  });

  it('is refused when a dependency id does not exist', () => {
    const ticket = makeTicket({ id: 'T1', depends_on: ['GHOST'] });
    const result = canTransition(ticket, 'ready', 'orchestrator', { tickets: [ticket] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('GHOST');
  });

  it('is refused when the sibling ticket set was not supplied', () => {
    const ticket = makeTicket({ id: 'T1', depends_on: ['T0'] });
    expect(canTransition(ticket, 'ready', 'orchestrator').ok).toBe(false);
  });
});

describe('gates -> code_review (the hard gate)', () => {
  const at = (status: TicketState) => makeTicket({ status });

  it('is refused when tests fail', () => {
    const ticket = makeTicket({
      status: 'gates',
      gate_results: { ...greenGates(), tests: gateResult('fail') },
    });
    const result = canTransition(ticket, 'code_review', 'orchestrator');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('tests');
  });

  it('is refused when lint fails', () => {
    const ticket = makeTicket({
      status: 'gates',
      gate_results: { ...greenGates(), lint: gateResult('fail') },
    });
    expect(canTransition(ticket, 'code_review', 'orchestrator').ok).toBe(false);
  });

  it('is refused when build fails', () => {
    const ticket = makeTicket({
      status: 'gates',
      gate_results: { ...greenGates(), build: gateResult('fail') },
    });
    expect(canTransition(ticket, 'code_review', 'orchestrator').ok).toBe(false);
  });

  it('is refused when a gate result is missing entirely', () => {
    const { tests, lint } = greenGates();
    const ticket = makeTicket({ status: 'gates', gate_results: { tests, lint } });
    const result = canTransition(ticket, 'code_review', 'orchestrator');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('build');
  });

  it('is refused when there are no gate results at all', () => {
    const ticket = makeTicket({ status: 'gates', gate_results: null });
    expect(canTransition(ticket, 'code_review', 'orchestrator').ok).toBe(false);
  });

  it('is refused when a gate was skipped rather than passed', () => {
    const ticket = makeTicket({
      status: 'gates',
      gate_results: { ...greenGates(), lint: gateResult('skipped') },
    });
    expect(canTransition(ticket, 'code_review', 'orchestrator').ok).toBe(false);
  });

  it('is allowed only when tests, lint and build all pass', () => {
    const ticket = makeTicket({ status: 'gates', gate_results: greenGates() });
    expect(canTransition(ticket, 'code_review', 'orchestrator').ok).toBe(true);
  });

  it('cannot be reached from anywhere except gates', () => {
    for (const state of TICKET_STATES) {
      if (state === 'gates' || state === 'needs_human') continue;
      expect(
        canTransition(at(state), 'code_review', 'orchestrator', { tickets: [] }).ok,
        `${state} -> code_review must be refused`,
      ).toBe(false);
    }
  });

  it('a red ticket bounces back to in_progress instead', () => {
    const ticket = makeTicket({
      status: 'gates',
      gate_results: { ...greenGates(), tests: gateResult('fail') },
    });
    expect(canTransition(ticket, 'in_progress', 'orchestrator').ok).toBe(true);
  });
});

describe('merge -> done (the only route onto a shared branch)', () => {
  const atMerge = () => makeTicket({ id: 'T1', status: 'merge' });

  it('is refused when the merge was not clean', () => {
    const result = canTransition(atMerge(), 'done', 'orchestrator', {
      mergeClean: false,
      featureBranchGatesGreen: true,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not merged cleanly/i);
  });

  it('is refused when the feature branch gates are red after the merge', () => {
    const result = canTransition(atMerge(), 'done', 'orchestrator', {
      mergeClean: true,
      featureBranchGatesGreen: false,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/feature branch gates/i);
  });

  it('is refused when the caller supplied no merge evidence at all', () => {
    expect(canTransition(atMerge(), 'done', 'orchestrator').ok).toBe(false);
    expect(canTransition(atMerge(), 'done', 'orchestrator', { tickets: [] }).ok).toBe(false);
  });

  it('is refused when only one of the two facts holds', () => {
    expect(canTransition(atMerge(), 'done', 'orchestrator', { mergeClean: true }).ok).toBe(false);
    expect(
      canTransition(atMerge(), 'done', 'orchestrator', { featureBranchGatesGreen: true }).ok,
    ).toBe(false);
  });

  it('applyTransition throws rather than marking a ticket done on a bad merge', () => {
    expect(() =>
      applyTransition(atMerge(), 'done', 'orchestrator', {
        now: NOW,
        ctx: { mergeClean: false, featureBranchGatesGreen: true },
      }),
    ).toThrow(TransitionError);
    expect(() =>
      applyTransition(atMerge(), 'done', 'orchestrator', {
        now: NOW,
        ctx: { mergeClean: true, featureBranchGatesGreen: false },
      }),
    ).toThrow(/feature branch gates/i);
    expect(() => applyTransition(atMerge(), 'done', 'orchestrator', { now: NOW })).toThrow(
      TransitionError,
    );
  });

  it('is allowed only when the merge was clean and the branch gates are green', () => {
    expect(
      canTransition(atMerge(), 'done', 'orchestrator', {
        mergeClean: true,
        featureBranchGatesGreen: true,
      }).ok,
    ).toBe(true);
    const after = applyTransition(atMerge(), 'done', 'orchestrator', {
      now: NOW,
      ctx: { mergeClean: true, featureBranchGatesGreen: true },
    });
    expect(after.frontmatter.status).toBe('done');
  });

  it('carries a guard on the merge -> done rule at all', () => {
    // If a later phase drops the guard from the table, the refusal tests above
    // would still pass via some other rule; this asserts the wiring directly.
    const rules = TICKET_TRANSITIONS.filter((rule) => rule.from === 'merge' && rule.to === 'done');
    expect(rules).toHaveLength(1);
    for (const rule of rules) {
      expect(typeof rule.guard).toBe('function');
    }
  });

  it('done is not reachable from merge by any other actor', () => {
    for (const actor of ['human', 'developer', 'qa', 'code_reviewer', 'pm', 'tl_plan', 'dl'] as const) {
      expect(
        canTransition(atMerge(), 'done', actor, {
          mergeClean: true,
          featureBranchGatesGreen: true,
        }).ok,
        `${actor} must not be able to mark a ticket done`,
      ).toBe(false);
    }
  });
});

describe('done is terminal', () => {
  it('no transition can move a ticket from done to any other state', () => {
    expect(TICKET_TRANSITIONS.filter((rule) => rule.from === 'done')).toEqual([]);
    for (const to of TICKET_STATES) {
      const ticket = makeTicket({ status: 'done' });
      expect(canTransition(ticket, to, 'orchestrator', { tickets: [] }).ok).toBe(false);
      expect(canTransition(ticket, to, 'human', { tickets: [] }).ok).toBe(false);
      expect(() => applyTransition(ticket, to, 'human', { now: NOW })).toThrow(TransitionError);
    }
  });

  it('no transition can move a feature from done to any other state', () => {
    expect(FEATURE_TRANSITIONS.filter((rule) => rule.from === 'done')).toEqual([]);
    for (const to of ALL_FEATURE_STATES) {
      const feature = makeFeature({ status: 'done' });
      expect(canTransition(feature, to, 'human', { tickets: [] }).ok).toBe(false);
    }
  });
});

describe('actor enforcement', () => {
  it('refuses a transition attempted by an actor the rule does not list', () => {
    const ticket = makeTicket({ status: 'ready' });
    expect(canTransition(ticket, 'in_progress', 'orchestrator').ok).toBe(true);
    const refused = canTransition(ticket, 'in_progress', 'pm');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('pm');
  });

  it('only the code reviewer moves a ticket out of code_review', () => {
    const ticket = makeTicket({ status: 'code_review' });
    expect(canTransition(ticket, 'qa', 'code_reviewer').ok).toBe(true);
    expect(canTransition(ticket, 'qa', 'qa').ok).toBe(false);
    expect(canTransition(ticket, 'qa', 'developer').ok).toBe(false);
  });

  it('only a human resumes an item out of needs_human', () => {
    const ticket = makeTicket({ status: 'needs_human' });
    expect(canTransition(ticket, 'in_progress', 'human').ok).toBe(true);
    expect(canTransition(ticket, 'in_progress', 'orchestrator').ok).toBe(false);
  });
});

describe('applyTransition', () => {
  it('appends exactly one ## History line in `timestamp | from -> to | actor | note` format', () => {
    const before = makeTicket({ status: 'ready' });
    const after = applyTransition(before, 'in_progress', 'orchestrator', {
      now: NOW,
      note: 'claimed by run-1',
    });

    const lines = historyLines(after.body);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${NOW} | ready → in_progress | orchestrator | claimed by run-1`);
    expect(after.body).toContain(HISTORY_HEADING);
  });

  it('omits the trailing separator when there is no note', () => {
    const after = applyTransition(makeTicket({ status: 'ready' }), 'in_progress', 'orchestrator', {
      now: NOW,
    });
    expect(historyLines(after.body)[0]).toBe(`${NOW} | ready → in_progress | orchestrator`);
  });

  it('appends to an existing ## History section rather than creating a second one', () => {
    const first = applyTransition(makeTicket({ status: 'ready' }), 'in_progress', 'orchestrator', {
      now: NOW,
    });
    const second = applyTransition(first, 'gates', 'orchestrator', {
      now: '2026-02-02T13:00:00Z',
    });

    expect(second.body.match(/^## History$/gm)).toHaveLength(1);
    expect(historyLines(second.body)).toHaveLength(2);
    expect(historyLines(second.body)[1]).toContain('in_progress → gates');
  });

  it('inserts history at the end of the History section, before any later heading', () => {
    const body = ['## Summary', '', 'Some text.', '', '## History', '', '- older entry', '', '## Review Notes', '', 'x', ''].join('\n');
    const after = applyTransition(makeTicket({ status: 'ready' }, body), 'in_progress', 'orchestrator', {
      now: NOW,
    });

    const historyIdx = after.body.indexOf('## History');
    const reviewIdx = after.body.indexOf('## Review Notes');
    const entryIdx = after.body.indexOf(NOW);
    expect(entryIdx).toBeGreaterThan(historyIdx);
    expect(entryIdx).toBeLessThan(reviewIdx);
    expect(after.body).toContain('## Summary');
    expect(after.body).toContain('- older entry');
  });

  it('preserves a body that has no History section, appending one at the end', () => {
    const after = applyTransition(
      makeTicket({ status: 'ready' }, '## Description\n\nBuild the thing.\n'),
      'in_progress',
      'orchestrator',
      { now: NOW },
    );
    expect(after.body).toContain('## Description\n\nBuild the thing.');
    expect(after.body.indexOf('## History')).toBeGreaterThan(after.body.indexOf('## Description'));
  });

  it('bumps updated_at and leaves every other frontmatter field byte-identical', () => {
    const before = makeTicket({ status: 'ready', attempts: 2, cost_usd: 1.5, branch: 'feat/x/t001' });
    const after = applyTransition(before, 'in_progress', 'orchestrator', { now: NOW });

    expect(after.frontmatter.updated_at).toBe(NOW);
    expect(after.frontmatter.status).toBe('in_progress');

    const strip = (fm: Record<string, unknown>): Record<string, unknown> => {
      const { status: _status, updated_at: _updated, ...rest } = fm;
      return rest;
    };
    expect(JSON.stringify(strip({ ...after.frontmatter }))).toBe(
      JSON.stringify(strip({ ...before.frontmatter })),
    );
    expect(Object.keys(after.frontmatter)).toEqual(Object.keys(before.frontmatter));
  });

  it('never mutates its input note (frozen input)', () => {
    const before = deepFreeze(makeTicket({ status: 'ready' }, '## History\n\n- seed\n'));
    const after = applyTransition(before, 'in_progress', 'orchestrator', { now: NOW });

    expect(before.frontmatter.status).toBe('ready');
    expect(before.frontmatter.updated_at).not.toBe(NOW);
    expect(before.body).toBe('## History\n\n- seed\n');
    expect(after).not.toBe(before);
    expect(after.frontmatter).not.toBe(before.frontmatter);
  });

  it('refuses to apply an illegal transition', () => {
    const ticket = makeTicket({ status: 'backlog' });
    expect(() => applyTransition(ticket, 'merge', 'orchestrator', { now: NOW })).toThrow(
      TransitionError,
    );
    expect(() => applyTransition(ticket, 'merge', 'orchestrator', { now: NOW })).toThrow(
      /backlog/,
    );
  });

  it('refuses when the guard refuses, and names the reason', () => {
    const ticket = makeTicket({ id: 'T2', depends_on: ['T1'] });
    const siblings = [makeTicket({ id: 'T1', status: 'in_progress' }), ticket];
    expect(() =>
      applyTransition(ticket, 'ready', 'orchestrator', { now: NOW, ctx: { tickets: siblings } }),
    ).toThrow(/T1/);
  });

  it('records the deciding role as the actor, not the orchestrator', () => {
    const ticket = makeTicket({ status: 'qa' });
    const after = applyTransition(ticket, 'in_progress', 'qa', { now: NOW, note: 'AC 3 failed' });
    expect(historyLines(after.body)[0]).toContain('| qa | AC 3 failed');
  });
});

describe('formatHistoryLine', () => {
  it('renders the documented format', () => {
    expect(
      formatHistoryLine({
        timestamp: NOW,
        from: 'gates',
        to: 'code_review',
        actor: 'orchestrator',
        note: 'all green',
      }),
    ).toBe(`${NOW} | gates → code_review | orchestrator | all green`);
  });

  it('collapses a multi-line note onto one line so the section stays parseable', () => {
    const line = formatHistoryLine({
      timestamp: NOW,
      from: 'qa',
      to: 'in_progress',
      actor: 'qa',
      note: 'first\nsecond',
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('first');
    expect(line).toContain('second');
  });
});

describe('feature transitions', () => {
  it('in_development -> awaiting_feature_close is refused while any ticket is not done', () => {
    const feature = makeFeature({ slug: 'x', status: 'in_development' });
    const tickets = [
      makeTicket({ id: 'T1', feature: 'x', status: 'done' }),
      makeTicket({ id: 'T2', feature: 'x', status: 'qa' }),
    ];
    const result = canTransition(feature, 'awaiting_feature_close', 'orchestrator', { tickets });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('T2');
  });

  it('in_development -> awaiting_feature_close is allowed once every ticket is done', () => {
    const feature = makeFeature({ slug: 'x', status: 'in_development' });
    const tickets = [
      makeTicket({ id: 'T1', feature: 'x', status: 'done' }),
      makeTicket({ id: 'T2', feature: 'x', status: 'done' }),
    ];
    expect(canTransition(feature, 'awaiting_feature_close', 'orchestrator', { tickets }).ok).toBe(
      true,
    );
  });

  it('ignores tickets belonging to another feature', () => {
    const feature = makeFeature({ slug: 'x', status: 'in_development' });
    const tickets = [
      makeTicket({ id: 'T1', feature: 'x', status: 'done' }),
      makeTicket({ id: 'OTHER-T1', feature: 'y', status: 'in_progress' }),
    ];
    expect(canTransition(feature, 'awaiting_feature_close', 'orchestrator', { tickets }).ok).toBe(
      true,
    );
  });

  it('a feature with no tickets cannot close', () => {
    const feature = makeFeature({ slug: 'x', status: 'in_development' });
    const result = canTransition(feature, 'awaiting_feature_close', 'orchestrator', { tickets: [] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no tickets/i);
  });

  it('the TL can send a feature back from planning to refining', () => {
    const feature = makeFeature({ status: 'planning' });
    expect(canTransition(feature, 'refining', 'tl_plan').ok).toBe(true);
    expect(canTransition(feature, 'refining', 'developer').ok).toBe(false);
  });

  it('final acceptance is the only route to done, and only a human takes it', () => {
    expect(
      FEATURE_TRANSITIONS.filter((rule) => rule.to === 'done').map((rule) => rule.from).sort(),
    ).toEqual(['awaiting_feature_close', 'needs_human']);
    for (const rule of FEATURE_TRANSITIONS.filter((r) => r.to === 'done')) {
      expect(rule.actors).toEqual(['human']);
    }
  });

  it('every rule is reachable from intake', () => {
    const reachable = new Set<FeatureState>(['intake']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of FEATURE_TRANSITIONS) {
        if (reachable.has(rule.from) && !reachable.has(rule.to)) {
          reachable.add(rule.to);
          grew = true;
        }
      }
    }
    expect(FEATURE_TRANSITIONS.filter((rule) => !reachable.has(rule.from))).toEqual([]);
  });
});

describe('exhaustive sweep — every (from, to) pair not in the rule table is refused', () => {
  const ALL_ACTORS = [
    'orchestrator',
    'human',
    'pm',
    'tl_plan',
    'dl',
    'developer',
    'code_reviewer',
    'qa',
  ] as const;

  it('for tickets', () => {
    const allowed = new Set(TICKET_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`));
    const wronglyAllowed: string[] = [];

    for (const from of TICKET_STATES) {
      for (const to of TICKET_STATES) {
        if (allowed.has(`${from}->${to}`)) continue;
        for (const actor of ALL_ACTORS) {
          // Hand every guard everything it could possibly want, so a refusal
          // can only come from the table itself, never from a missing input.
          const ticket = makeTicket({
            id: 'T1',
            status: from,
            depends_on: [],
            gate_results: greenGates(),
          });
          const result = canTransition(ticket, to, actor, {
            tickets: [ticket],
            mergeClean: true,
            featureBranchGatesGreen: true,
          });
          if (result.ok) wronglyAllowed.push(`${from} -> ${to} by ${actor}`);
        }
      }
    }

    expect(wronglyAllowed).toEqual([]);
  });

  it('for features', () => {
    const allowed = new Set(FEATURE_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`));
    const wronglyAllowed: string[] = [];

    for (const from of ALL_FEATURE_STATES) {
      for (const to of ALL_FEATURE_STATES) {
        if (allowed.has(`${from}->${to}`)) continue;
        for (const actor of ALL_ACTORS) {
          const feature = makeFeature({ slug: 'x', status: from });
          const result = canTransition(feature, to, actor, {
            tickets: [makeTicket({ id: 'T1', feature: 'x', status: 'done' })],
          });
          if (result.ok) wronglyAllowed.push(`${from} -> ${to} by ${actor}`);
        }
      }
    }

    expect(wronglyAllowed).toEqual([]);
  });

  it('every pair that IS in the table is allowed for at least one actor, given satisfied guards', () => {
    const stillRefused: string[] = [];
    for (const rule of TICKET_TRANSITIONS) {
      const ticket = makeTicket({
        id: 'T1',
        status: rule.from,
        depends_on: [],
        gate_results: greenGates(),
      });
      const anyAllowed = rule.actors.some(
        (actor) =>
          canTransition(ticket, rule.to, actor, {
            tickets: [ticket],
            mergeClean: true,
            featureBranchGatesGreen: true,
          }).ok,
      );
      if (!anyAllowed) stillRefused.push(`${rule.from} -> ${rule.to}`);
    }
    expect(stillRefused).toEqual([]);
  });
});

describe('guards in isolation', () => {
  it('allDependenciesDone names every unsatisfied dependency', () => {
    const ticket = makeTicket({ id: 'T3', depends_on: ['T1', 'T2'] });
    const result = allDependenciesDone(ticket, {
      tickets: [
        makeTicket({ id: 'T1', status: 'ready' }),
        makeTicket({ id: 'T2', status: 'gates' }),
        ticket,
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('T1');
    expect(result.ok === false && result.reason).toContain('T2');
  });

  it('gatesAllGreen names every gate that is not passing', () => {
    const result = gatesAllGreen(
      makeTicket({
        gate_results: { tests: gateResult('pass'), lint: gateResult('fail'), build: gateResult('fail') },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('lint');
    expect(result.ok === false && result.reason).toContain('build');
  });

  it('allTicketsDone requires the ticket set to be supplied', () => {
    expect(allTicketsDone(makeFeature({ slug: 'x' }), {}).ok).toBe(false);
  });

  it('attemptsRemaining prefers the ticket override over the config default', () => {
    const ticket = makeTicket({ attempts: 3, max_attempts: 5 });
    expect(attemptsRemaining(ticket, { defaultMaxAttempts: 3 }).ok).toBe(true);

    const noOverride = makeTicket({ attempts: 3, max_attempts: null });
    expect(attemptsRemaining(noOverride, { defaultMaxAttempts: 3 }).ok).toBe(false);
  });

  it('mergeVerified refuses a merge that was not clean', () => {
    const result = mergeVerified(makeTicket({ id: 'T1', status: 'merge' }), {
      mergeClean: false,
      featureBranchGatesGreen: true,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('T1');
    expect(result.ok === false && result.reason).toMatch(/not merged cleanly/i);
  });

  it('mergeVerified refuses when the feature branch gates are not green', () => {
    const result = mergeVerified(makeTicket({ id: 'T1', status: 'merge' }), {
      mergeClean: true,
      featureBranchGatesGreen: false,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('T1');
    expect(result.ok === false && result.reason).toMatch(/feature branch gates/i);
  });

  it('mergeVerified refuses on empty context — absent evidence is not evidence', () => {
    expect(mergeVerified(makeTicket({ status: 'merge' }), {}).ok).toBe(false);
    expect(mergeVerified(makeTicket({ status: 'merge' }), { mergeClean: true }).ok).toBe(false);
    expect(
      mergeVerified(makeTicket({ status: 'merge' }), { featureBranchGatesGreen: true }).ok,
    ).toBe(false);
  });

  it('mergeVerified allows only when both facts are explicitly true', () => {
    expect(
      mergeVerified(makeTicket({ status: 'merge' }), {
        mergeClean: true,
        featureBranchGatesGreen: true,
      }).ok,
    ).toBe(true);
  });

  it('attemptsRemaining stops AT max_attempts, not one past it', () => {
    expect(attemptsRemaining(makeTicket({ attempts: 2 }), { defaultMaxAttempts: 3 }).ok).toBe(true);
    expect(attemptsRemaining(makeTicket({ attempts: 3 }), { defaultMaxAttempts: 3 }).ok).toBe(false);
    expect(attemptsRemaining(makeTicket({ attempts: 4 }), { defaultMaxAttempts: 3 }).ok).toBe(false);
  });
});

/**
 * Added in Phase 3 after the shared heading scan was extracted.
 *
 * Both of these functions used a plain line match to find `## History`, so a
 * fenced code block containing that text — an agent pasting a note template or
 * a transcript into a tech plan — captured every history line. The write went
 * into the code fence and the read came back out of it, on the live path that
 * `applyTransition` runs on every single transition.
 */
describe('history is fence-aware', () => {
  const DECOY_ABOVE = [
    '## Raw Requirement',
    '',
    'Notes should look like this:',
    '',
    '```md',
    '## History',
    '',
    '- 2020-01-01T00:00:00Z | a → b | orchestrator',
    '```',
    '',
    '## History',
    '',
    '- 2026-01-01T00:00:00Z | intake → refining | orchestrator',
    '',
  ].join('\n');

  it('appendHistoryLine writes into the real section, not the code fence', () => {
    const out = appendHistoryLine(DECOY_ABOVE, {
      timestamp: '2026-01-02T00:00:00Z',
      from: 'refining',
      to: 'planning',
      actor: 'orchestrator',
    });

    // The fenced sample is untouched, byte for byte.
    expect(out).toContain(
      '```md\n## History\n\n- 2020-01-01T00:00:00Z | a → b | orchestrator\n```',
    );
    // The new entry lands under the real heading, after the existing entry.
    expect(out).toContain(
      [
        '## History',
        '',
        '- 2026-01-01T00:00:00Z | intake → refining | orchestrator',
        '- 2026-01-02T00:00:00Z | refining → planning | orchestrator',
      ].join('\n'),
    );
  });

  it('appendHistoryLine creates a real section when the only match is fenced', () => {
    const body = ['## Raw Requirement', '', '```md', '## History', '```', ''].join('\n');
    const out = appendHistoryLine(body, {
      timestamp: '2026-01-01T00:00:00Z',
      from: 'intake',
      to: 'refining',
      actor: 'orchestrator',
    });

    expect(out).toContain('```md\n## History\n```');
    expect(out.trimEnd().endsWith('- 2026-01-01T00:00:00Z | intake → refining | orchestrator')).toBe(
      true,
    );
    expect(historyLines(out)).toEqual([
      '2026-01-01T00:00:00Z | intake → refining | orchestrator',
    ]);
  });

  it('appendHistoryLine does not stop the section at a fenced ## inside History', () => {
    const body = [
      '## History',
      '',
      '- 2026-01-01T00:00:00Z | intake → refining | orchestrator',
      '',
      '```md',
      '## Not a heading',
      '```',
      '',
    ].join('\n');

    const out = appendHistoryLine(body, {
      timestamp: '2026-01-02T00:00:00Z',
      from: 'refining',
      to: 'planning',
      actor: 'orchestrator',
    });

    expect(out.indexOf('2026-01-02T00:00:00Z')).toBeGreaterThan(out.indexOf('## Not a heading'));
    expect(historyLines(out)).toHaveLength(2);
  });

  it('historyLines reads the real section, not the fenced decoy', () => {
    expect(historyLines(DECOY_ABOVE)).toEqual([
      '2026-01-01T00:00:00Z | intake → refining | orchestrator',
    ]);
  });

  it('historyLines returns nothing when the only ## History is inside a fence', () => {
    const body = [
      '## Raw Requirement',
      '',
      '```md',
      '## History',
      '',
      '- 2020-01-01T00:00:00Z | a → b | orchestrator',
      '```',
      '',
    ].join('\n');
    expect(historyLines(body)).toEqual([]);
  });

  it('historyLines ignores bullet lines inside a fence within the History section', () => {
    const body = [
      '## History',
      '',
      '- 2026-01-01T00:00:00Z | intake → refining | orchestrator',
      '',
      '```text',
      '- 1999-01-01T00:00:00Z | not | a | real | entry',
      '```',
      '',
      '- 2026-01-02T00:00:00Z | refining → planning | orchestrator',
      '',
    ].join('\n');

    expect(historyLines(body)).toEqual([
      '2026-01-01T00:00:00Z | intake → refining | orchestrator',
      '2026-01-02T00:00:00Z | refining → planning | orchestrator',
    ]);
  });

  it('a full applyTransition round trip survives a decoy fence', () => {
    const note = makeFeature({ status: 'intake' }, DECOY_ABOVE);
    const moved = applyTransition(note, 'refining', 'orchestrator', {
      now: '2026-02-01T00:00:00Z',
    });

    expect(historyLines(moved.body)).toEqual([
      '2026-01-01T00:00:00Z | intake → refining | orchestrator',
      '2026-02-01T00:00:00Z | intake → refining | orchestrator',
    ]);
    expect(moved.body).toContain('- 2020-01-01T00:00:00Z | a → b | orchestrator\n```');
  });
});
