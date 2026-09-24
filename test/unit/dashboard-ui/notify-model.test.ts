/** Desktop notifications (plan Phase 8, J7): which waiting items raise one, and when the banner shows. */
import { describe, expect, it } from 'vitest';

import { bannerVisible, diffWaiting, notificationFor } from '../../../dashboard-ui/notifyModel.js';
import { CHECKPOINTS } from '../../../src/orchestrator/checkpoints.js';

describe('diffWaiting', () => {
  it('the first snapshot only primes: what was waiting when the page opened raises nothing', () => {
    expect(diffWaiting(null, ['FEAT-A'])).toEqual({ fresh: [], seen: ['FEAT-A'] });
  });

  it('only ids not seen before trigger', () => {
    const first = diffWaiting(null, ['FEAT-A']);
    const second = diffWaiting(first.seen, ['FEAT-A', 'FEAT-A-T001']);
    expect(second.fresh).toEqual(['FEAT-A-T001']);
    expect(diffWaiting(second.seen, ['FEAT-A-T001', 'FEAT-A']).fresh).toEqual([]);
  });

  it('an id that leaves and comes back triggers again', () => {
    let seen = diffWaiting(null, []).seen;
    const steps = [['FEAT-A'], [], ['FEAT-A']];
    const fresh = steps.map((ids) => {
      const next = diffWaiting(seen, ids);
      seen = next.seen;
      return next.fresh;
    });
    expect(fresh).toEqual([['FEAT-A'], [], ['FEAT-A']]);
  });

  it('a repeated id in one snapshot triggers once', () => {
    expect(diffWaiting([], ['FEAT-A', 'FEAT-A']).fresh).toEqual(['FEAT-A']);
  });
});

describe('bannerVisible', () => {
  const base = { supported: true, permission: 'default', dismissed: false, waiting: 1 };

  it('shows the first time something waits, when the browser can still ask', () => {
    expect(bannerVisible(base)).toBe(true);
  });

  it.each([
    ['nothing is waiting', { waiting: 0 }],
    ['"Not now" was chosen', { dismissed: true }],
    ['permission was already granted', { permission: 'granted' }],
    ['permission was denied', { permission: 'denied' }],
    ['the browser has no notifications', { supported: false }],
  ])('hides when %s', (_why, over) => {
    expect(bannerVisible({ ...base, ...over })).toBe(false);
  });
});

describe('notificationFor', () => {
  const item = (over: Record<string, unknown>) => ({
    id: 'FEAT-CALC',
    title: 'Calculator',
    status: 'needs_human',
    kind: 'feature',
    pause_reason: 'checkpoint',
    pause_detail: null,
    resume_to: CHECKPOINTS.after_pm_refinement.resumeTo,
    reject_to: CHECKPOINTS.after_pm_refinement.rejectTo,
    paused_at: null,
    ...over,
  });

  it('names the project and says what is ready, tagged by id', () => {
    expect(notificationFor(item({}), 'calc-poc')).toEqual({
      title: 'App Factory',
      body: "calc-poc: the PM's requirement is ready for your review.",
      tag: 'FEAT-CALC',
    });
    expect(notificationFor(item({ resume_to: 'in_development', reject_to: 'ticketing' }), 'calc-poc').body).toBe(
      'calc-poc: the tickets are ready for your review.',
    );
    expect(notificationFor(item({ resume_to: 'done', reject_to: 'in_development' }), 'calc-poc').body).toBe(
      'calc-poc: Calculator is ready for final acceptance.',
    );
  });

  it('an escalation names the item and the reason', () => {
    const body = notificationFor(item({ id: 'FEAT-CALC-T002', title: 'Evaluator', kind: 'ticket', pause_reason: 'timeout' }), 'calc-poc').body;
    expect(body).toBe('calc-poc: Evaluator needs you (Timed out).');
  });

  it('without a project name the body starts with the item', () => {
    expect(notificationFor(item({}), '').body).toBe("The PM's requirement is ready for your review.");
  });
});
