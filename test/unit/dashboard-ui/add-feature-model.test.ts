/** The add-feature form's rules (plan Phase 8, J2 and A9): when it may submit, and when it is blocked. */
import { describe, expect, it } from 'vitest';

import { DEMO_REFUSAL, blockedText, blockingFeature, draftState } from '../../../dashboard-ui/addFeatureModel.js';
import { DEMO_ADD_FEATURE_REFUSAL } from '../../../src/dashboard/constants.js';

const done = { id: 'FEAT-OLD-THING', slug: 'old-thing', title: 'Old thing', status: 'done' };
const active = { id: 'FEAT-CALC', slug: 'calc', title: 'Expression calculator', status: 'in_development' };

describe('blockingFeature (A9)', () => {
  it('is the first feature that is not done', () => {
    expect(blockingFeature([done, active])).toEqual(active);
  });

  it('is null when every feature is done, or there are none', () => {
    expect(blockingFeature([done])).toBeNull();
    expect(blockingFeature([])).toBeNull();
  });

  it('a feature waiting for you still blocks', () => {
    expect(blockingFeature([{ ...active, status: 'needs_human' }])).not.toBeNull();
  });
});

describe('blockedText', () => {
  it('names the feature and its stage, in the J2 words', () => {
    expect(blockedText(active)).toBe(
      'The factory builds one feature at a time for now. Expression calculator is still in development. ' +
        'Finish it (or let it be delivered) before adding the next one.',
    );
  });

  it.each([
    ['intake', 'waiting to be picked up'],
    ['refining', 'being refined'],
    ['needs_human', 'waiting for you'],
    ['awaiting_feature_close', 'at the final check'],
  ])('%s reads "%s"', (status, words) => {
    expect(blockedText({ ...active, status })).toContain(`Expression calculator is still ${words}.`);
  });
});

describe('draftState', () => {
  const draft = { name: 'Expression calculator', requirement: 'Evaluate 2 + 3 * 4 → 14' };

  it('a named draft with a requirement and nothing active can be submitted, with its id preview', () => {
    expect(draftState(draft, [done])).toMatchObject({
      preview: { slug: 'expression-calculator', id: 'FEAT-EXPRESSION-CALCULATOR' },
      blocker: null,
      duplicate: null,
      canSubmit: true,
    });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['an empty requirement', { requirement: ' \n ' }],
    ['a name with no usable characters', { name: '!!!' }],
  ])('%s cannot be submitted', (_why, over) => {
    expect(draftState({ ...draft, ...over }, []).canSubmit).toBe(false);
  });

  it('a name another feature already has is refused, naming that feature', () => {
    const state = draftState({ ...draft, name: 'Old thing' }, [done]);
    expect(state.canSubmit).toBe(false);
    expect(state.duplicate).toEqual(done);
  });

  it('any feature not done blocks the form, whatever the draft', () => {
    const state = draftState(draft, [done, active]);
    expect(state.blocker).toEqual(active);
    expect(state.canSubmit).toBe(false);
  });
});

describe('draftState in demo mode (Phase 8 review fix 3)', () => {
  const draft = { name: 'Expression calculator', requirement: 'Evaluate 2 + 3 * 4 → 14' };

  it('is blocked with the demo message, even with nothing active', () => {
    const state = draftState(draft, [], { demo: true });
    expect(state.demoBlocked).toBe(true);
    expect(state.canSubmit).toBe(false);
  });

  it('is not blocked outside demo mode', () => {
    expect(draftState(draft, []).demoBlocked).toBe(false);
    expect(draftState(draft, [], { demo: false }).canSubmit).toBe(true);
  });

  it('shows the same words the server refuses with', () => {
    expect(DEMO_REFUSAL).toBe(
      'The demo runs one scripted feature. Use `factory dashboard` on a real project to add your own.',
    );
    expect(DEMO_REFUSAL).toBe(DEMO_ADD_FEATURE_REFUSAL);
  });
});
