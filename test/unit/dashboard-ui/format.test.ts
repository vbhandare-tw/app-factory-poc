/**
 * Display formatting for the page (plan Phase 7). The label tables are a
 * mirror of `src/dashboard/labels.ts` (the browser cannot import TypeScript),
 * so these tests are what keeps the two copies in step.
 */
import { describe, expect, it } from 'vitest';

import {
  FEATURE_STRIP,
  TICKET_COLUMNS,
  TONES,
  actorLabel,
  cwdFromInitLine,
  duration,
  isRoutineEvent,
  money,
  parseRunId,
  pauseLabel,
  relativeTime,
  relativizePaths,
  roleLabel,
  stageClass,
  stageLabel,
  stripPosition,
} from '../../../dashboard-ui/format.js';
import { PAUSE_REASON_LABELS, ROLE_LABELS, STAGE_LABELS } from '../../../src/dashboard/labels.js';
import { runId } from '../../../src/domain/ids.js';
import { CHECKPOINTS } from '../../../src/orchestrator/checkpoints.js';
import { ROLES } from '../../../src/domain/roles.js';
import { ALL_FEATURE_STATES, FEATURE_STATES, PAUSE_REASONS, TICKET_STATES } from '../../../src/domain/states.js';

const ALL_STAGES = [...new Set([...ALL_FEATURE_STATES, ...TICKET_STATES])];

describe('money', () => {
  it.each([
    [0.1234, '$0.12'],
    [0, '$0.00'],
    [1.1554462, '$1.16'],
    [1234.5, '$1,234.50'],
  ])('%s → %s', (usd, expected) => {
    expect(money(usd)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN])('%s → an em dash', (value) => {
    expect(money(value)).toBe('—');
  });
});

describe('duration', () => {
  it.each([
    [1_237_000, '20m 37s'],
    [3_007, '3s'],
    [60_000, '1m 0s'],
    [3_725_000, '1h 2m'],
    [450, '<1s'],
    [0, '<1s'],
  ])('%s ms → %s', (ms, expected) => {
    expect(duration(ms)).toBe(expected);
  });

  it.each([null, undefined, -1, Number.NaN])('%s → an em dash', (value) => {
    expect(duration(value)).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-24T12:00:00.000Z');

  it.each([
    ['2026-09-24T11:59:58.000Z', 'just now'],
    ['2026-09-24T11:59:30.000Z', '30s ago'],
    ['2026-09-24T11:57:00.000Z', '3m ago'],
    ['2026-09-24T10:00:00.000Z', '2h ago'],
    ['2026-09-21T12:00:00.000Z', '3d ago'],
    ['2026-09-24T12:00:05.000Z', 'just now'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it.each([null, undefined, '', 'not a date'])('%s → empty', (value) => {
    expect(relativeTime(value, now)).toBe('');
  });
});

describe('stage colour classes', () => {
  it.each(ALL_STAGES)('%s maps to one of the semantic tone classes', (stage) => {
    expect(TONES.map((tone) => `tone-${tone}`)).toContain(stageClass(stage));
  });

  it('encodes the states the spec names by colour', () => {
    expect(stageClass('needs_human')).toBe('tone-waiting');
    expect(stageClass('done')).toBe('tone-done');
    expect(stageClass('blocked')).toBe('tone-failed');
    expect(stageClass('regression')).toBe('tone-failed');
    expect(stageClass('in_progress')).toBe('tone-running');
    expect(stageClass('backlog')).toBe('tone-idle');
  });

  it('an unknown stage from a future build falls back to neutral', () => {
    expect(stageClass('somewhere_new')).toBe('tone-neutral');
  });
});

describe('label mirrors of src/dashboard/labels.ts', () => {
  it.each(ALL_STAGES)('stage %s', (stage) => {
    expect(stageLabel(stage)).toBe(STAGE_LABELS[stage]);
  });

  it.each(ROLES)('role %s', (role) => {
    expect(roleLabel(role)).toBe(ROLE_LABELS[role]);
  });

  it.each(PAUSE_REASONS)('pause reason %s', (reason) => {
    expect(pauseLabel(reason)).toBe(PAUSE_REASON_LABELS[reason]);
  });

  it('an unknown value is shown as itself, and null as an empty string', () => {
    expect(stageLabel('somewhere_new')).toBe('somewhere_new');
    expect(roleLabel('designer')).toBe('designer');
    expect(pauseLabel('gremlins')).toBe('gremlins');
    expect(roleLabel(null)).toBe('');
    expect(pauseLabel(null)).toBe('');
  });
});

describe('actorLabel', () => {
  it('names the factory, the person, and each agent role', () => {
    expect(actorLabel('orchestrator')).toBe('Factory');
    expect(actorLabel('human')).toBe('You');
    for (const role of ROLES) expect(actorLabel(role)).toBe(ROLE_LABELS[role]);
  });
});

describe('state orderings mirror src/domain/states.ts', () => {
  it('the ticket board has one column per ticket state, in TICKET_STATES order', () => {
    expect(TICKET_COLUMNS).toEqual(TICKET_STATES);
  });

  it('the feature progress strip is FEATURE_STATES without the needs_human pause', () => {
    expect(FEATURE_STRIP).toEqual(FEATURE_STATES.filter((s) => s !== 'needs_human'));
  });
});

describe('parseRunId', () => {
  it.each(ROLES)('reads back a %s run id built by src/domain/ids.ts', (role) => {
    expect(parseRunId(runId('FEAT-CALC-T001', role, 2, 17))).toEqual({
      itemId: 'FEAT-CALC-T001',
      role,
      attempt: 2,
    });
  });

  it.each(['', 'nonsense', 'FEAT-X-designer-a1-1', 'FEAT-X-pm-ax-1'])('%j → null', (value) => {
    expect(parseRunId(value)).toBeNull();
  });
});

describe('stripPosition', () => {
  it.each(Object.values(CHECKPOINTS).map((c) => [c.name, c] as const))(
    'at the %s checkpoint the stage waiting on you is the one the checkpoint parks from',
    (_name, spec) => {
      const pos = stripPosition('needs_human', spec.resumeTo, 'checkpoint');
      expect(pos.waiting).toBe(true);
      expect(FEATURE_STRIP[pos.at]).toBe(spec.from);
    },
  );

  it('after PM refinement, Refining is current-and-waiting and Planning has not started', () => {
    const pos = stripPosition('needs_human', 'planning', 'checkpoint');
    expect(FEATURE_STRIP[pos.at]).toBe('refining');
    expect(pos.at).toBeLessThan(FEATURE_STRIP.indexOf('planning'));
  });

  it('an escalation waits on the stage it will retry', () => {
    expect(stripPosition('needs_human', 'planning', 'escalation')).toEqual({
      at: FEATURE_STRIP.indexOf('planning'),
      waiting: true,
    });
  });

  it('a running feature lights its own stage; an unknown one lights nothing', () => {
    expect(stripPosition('ticketing', null, null)).toEqual({ at: FEATURE_STRIP.indexOf('ticketing'), waiting: false });
    expect(stripPosition('needs_human', null, 'checkpoint')).toEqual({ at: -1, waiting: true });
    expect(stripPosition('blocked', null, null)).toEqual({ at: -1, waiting: false });
  });
});

describe('transcript paths', () => {
  const cwd = '/Users/me/.factory-worktrees/vault-ab12/FEAT-CALC-T004';

  it('reads the cwd from a stream-json init line, or null', () => {
    expect(cwdFromInitLine(JSON.stringify({ type: 'system', subtype: 'init', cwd }))).toBe(cwd);
    expect(cwdFromInitLine(JSON.stringify({ type: 'assistant' }))).toBeNull();
    expect(cwdFromInitLine('{not json')).toBeNull();
    expect(cwdFromInitLine(undefined)).toBeNull();
  });

  it('shows a path inside the working directory relative to it', () => {
    expect(relativizePaths(`Read ${cwd}/src/evaluate.ts`, cwd)).toBe('Read src/evaluate.ts');
    expect(relativizePaths(`Ran cd ${cwd} && npm test`, cwd)).toBe('Ran cd . && npm test');
  });

  it('without a known cwd, strips a factory worktree prefix', () => {
    expect(relativizePaths(`Edited ${cwd}/src/a.ts`, null)).toBe('Edited src/a.ts');
  });

  it('leaves other paths and a sibling directory with the same prefix alone', () => {
    expect(relativizePaths('Read /etc/hosts', cwd)).toBe('Read /etc/hosts');
    expect(relativizePaths(`Read ${cwd}-other/x.ts`, cwd)).toBe(`Read ${cwd}-other/x.ts`);
  });
});

describe('isRoutineEvent', () => {
  it.each([
    [{ type: 'claim_won', itemId: 'T1' }],
    [{ type: 'claim_released', itemId: 'T1' }],
    [{ type: 'cycle_started', cycle: 3 }],
    [{ type: 'worktrees_reconciled', kept: 2, created: 0, removed: 0 }],
    [{ type: 'cycle_finished', cycle: 3, dispatched: 0, quarantined: 0, errors: 0 }],
    [{ type: 'cost_recorded', itemId: 'T1', costUsd: 0, totalUsd: 0 }],
  ])('%j is routine', (event) => {
    expect(isRoutineEvent(event)).toBe(true);
  });

  it.each([
    [{ type: 'item_paused', itemId: 'T1' }],
    [{ type: 'gate_result', itemId: 'T1', gate: 'tests', status: 'fail' }],
    [{ type: 'cycle_finished', cycle: 3, dispatched: 1, quarantined: 0, errors: 0 }],
    [{ type: 'cycle_finished', cycle: 3, dispatched: 0, quarantined: 0, errors: 1 }],
    [{ type: 'worktrees_reconciled', kept: 0, created: 1, removed: 0 }],
    [{ type: 'cost_recorded', itemId: 'T1', costUsd: 0.12, totalUsd: 0.12 }],
    [{ type: 'some_future_event' }],
  ])('%j is shown', (event) => {
    expect(isRoutineEvent(event)).toBe(false);
  });
});
