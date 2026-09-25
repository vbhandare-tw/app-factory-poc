/**
 * Label and event-summary coverage (tech spec §1, plan Phase 2).
 */
import { describe, expect, it } from 'vitest';

import {
  PAUSE_REASON_LABELS,
  ROLE_LABELS,
  STAGE_LABELS,
  summariseEvent,
} from '../../../src/dashboard/labels.js';
import { ROLES } from '../../../src/domain/roles.js';
import { ALL_FEATURE_STATES, PAUSE_REASONS, TICKET_STATES } from '../../../src/domain/states.js';

describe('label coverage', () => {
  it('every role has a label', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
    }
  });

  it('every pause reason has a label', () => {
    for (const reason of PAUSE_REASONS) {
      expect(PAUSE_REASON_LABELS[reason], reason).toBeTruthy();
    }
  });

  it('every feature state has a label', () => {
    for (const state of ALL_FEATURE_STATES) {
      expect(STAGE_LABELS[state], state).toBeTruthy();
    }
  });

  it('every ticket state has a label', () => {
    for (const state of TICKET_STATES) {
      expect(STAGE_LABELS[state], state).toBeTruthy();
    }
  });
});

describe('summariseEvent', () => {
  const ts = '2026-09-24T00:00:00.000Z';

  it('item_transitioned', () => {
    const sentence = summariseEvent({
      ts,
      type: 'item_transitioned',
      itemId: 'FEAT-X',
      from: 'planning',
      to: 'ticketing',
      actor: 'dl',
    });
    expect(sentence).toBe('FEAT-X: planning → ticketing');
  });

  it('gates_finished, green', () => {
    const sentence = summariseEvent({
      ts,
      type: 'gates_finished',
      itemId: 'FEAT-X-T001',
      attempt: 1,
      green: true,
      commitSha: 'abc123',
      detail: '',
    });
    expect(sentence).toBe('FEAT-X-T001: gates green (attempt 1)');
  });

  it('gates_finished, red', () => {
    const sentence = summariseEvent({
      ts,
      type: 'gates_finished',
      itemId: 'FEAT-X-T001',
      attempt: 2,
      green: false,
      commitSha: null,
      detail: 'lint failed',
    });
    expect(sentence).toBe('FEAT-X-T001: gates red (attempt 2)');
  });

  it('merge_completed', () => {
    const sentence = summariseEvent({
      ts,
      type: 'merge_completed',
      itemId: 'FEAT-X-T001',
      into: 'feature/x',
      from: 'ticket/x-t001',
      sha: 'deadbeef',
      branchDeleted: true,
    });
    expect(sentence).toBe('FEAT-X-T001: merged into feature/x');
  });

  it('run_started', () => {
    const sentence = summariseEvent({
      ts,
      type: 'run_started',
      runId: 'r1',
      role: 'developer',
      itemId: 'FEAT-X-T001',
      attempt: 1,
      model: 'sonnet',
      pid: 123,
      logPath: '/tmp/x.log',
    });
    expect(sentence).toBe('Developer run started for FEAT-X-T001');
  });

  it('an unknown runtime type falls back to the type string, without throwing', () => {
    const event = { ts, type: 'a_future_event_type', foo: 'bar' };
    expect(() => summariseEvent(event)).not.toThrow();
    expect(summariseEvent(event)).toBe('a_future_event_type');
  });

  it('a known type with a missing or wrong-typed field falls back to the type string, without throwing', () => {
    expect(summariseEvent({ ts, type: 'commit_created', itemId: 'FEAT-X-T001' })).toBe('commit_created');
    expect(summariseEvent({ ts, type: 'tickets_created', featureId: 'FEAT-X' })).toBe('tickets_created');
    expect(summariseEvent({ ts, type: 'cost_recorded', itemId: 'FEAT-X', costUsd: '1.5', totalUsd: 2 })).toBe(
      'cost_recorded',
    );
  });
});
