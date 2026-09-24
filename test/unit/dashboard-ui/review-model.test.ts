/**
 * What the review page shows and allows for one waiting item (plan Phase 8,
 * J5 and J6). The checkpoint table mirrors `src/orchestrator/checkpoints.ts`,
 * so the first block keeps the two copies in step.
 */
import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_ROUTES,
  STANDING_APPROVAL,
  approveOutcome,
  checkpointOf,
  classifyFailure,
  deliveredMessage,
  mergeConfirmText,
  rejectOutcome,
  reviewModel,
  sendBackControl,
} from '../../../dashboard-ui/reviewModel.js';
import type { WaitingItem } from '../../../dashboard-ui/reviewModel.js';
import { CHECKPOINTS } from '../../../src/orchestrator/checkpoints.js';
import type { CheckpointName } from '../../../src/orchestrator/checkpoints.js';

const NAMES = Object.keys(CHECKPOINTS) as CheckpointName[];

function checkpoint(name: CheckpointName, over: Partial<WaitingItem> = {}): WaitingItem {
  return {
    id: 'FEAT-CALC',
    title: 'Calculator',
    status: 'needs_human',
    kind: 'feature',
    pause_reason: 'checkpoint',
    pause_detail: CHECKPOINTS[name].description,
    resume_to: CHECKPOINTS[name].resumeTo,
    reject_to: CHECKPOINTS[name].rejectTo,
    paused_at: '2026-09-24T10:00:00.000Z',
    ...over,
  };
}

function escalation(over: Partial<WaitingItem> = {}): WaitingItem {
  return {
    id: 'FEAT-CALC-T002',
    title: 'Evaluator',
    status: 'needs_human',
    kind: 'ticket',
    pause_reason: 'attempts_exhausted',
    pause_detail: 'The tests failed on all 3 attempts.',
    resume_to: 'ready',
    reject_to: null,
    paused_at: '2026-09-24T10:00:00.000Z',
    ...over,
  };
}

describe('the checkpoint mirror', () => {
  it('lists the same checkpoints, resume and reject targets as src/orchestrator/checkpoints.ts', () => {
    expect(Object.keys(CHECKPOINT_ROUTES).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(CHECKPOINT_ROUTES[name], name).toEqual({
        resumeTo: CHECKPOINTS[name].resumeTo,
        rejectTo: CHECKPOINTS[name].rejectTo,
      });
    }
  });
});

describe('checkpointOf', () => {
  it.each(NAMES)('a feature parked at %s is that checkpoint', (name) => {
    expect(checkpointOf(checkpoint(name))).toBe(name);
  });

  it('an escalation is no checkpoint, even with a checkpoint-like resume target', () => {
    expect(checkpointOf(escalation())).toBeNull();
    expect(checkpointOf(checkpoint('final_acceptance', { pause_reason: 'merge_conflict' }))).toBeNull();
  });

  it('a ticket is never a checkpoint', () => {
    expect(checkpointOf(checkpoint('after_pm_refinement', { kind: 'ticket' }))).toBeNull();
  });

  it('a checkpoint pause with an unknown resume target is treated as an escalation', () => {
    expect(checkpointOf(checkpoint('after_pm_refinement', { resume_to: 'intake' }))).toBeNull();
  });
});

describe('reviewModel: each checkpoint maps to its question and sections (J5)', () => {
  it('after the PM: "Is this what you meant?" over the refined requirement, criteria and notes', () => {
    expect(reviewModel(checkpoint('after_pm_refinement'))).toMatchObject({
      checkpoint: 'after_pm_refinement',
      escalation: false,
      question: 'Is this what you meant?',
      sections: ['refined', 'criteria', 'notes'],
      needsMergeConfirm: false,
      canApprove: true,
      canSendBack: true,
    });
  });

  it('after ticketing: the split question over the plan and the ticket list', () => {
    expect(reviewModel(checkpoint('after_ticket_breakdown'))).toMatchObject({
      checkpoint: 'after_ticket_breakdown',
      question: 'Is this the right split, and can each ticket be built on its own?',
      sections: ['plan', 'tickets'],
      needsMergeConfirm: false,
    });
  });

  it('final acceptance: "Merge this into <base>?" over the delivery, naming the base branch', () => {
    expect(reviewModel(checkpoint('final_acceptance'))).toMatchObject({
      checkpoint: 'final_acceptance',
      question: 'Merge this into main?',
      sections: ['delivery'],
    });
    expect(reviewModel(checkpoint('final_acceptance'), { baseBranch: 'develop' }).question).toBe(
      'Merge this into develop?',
    );
  });

  it('an escalation shows the explanation, what you can do and the logs, with its reason label (J6)', () => {
    const model = reviewModel(escalation());
    expect(model).toMatchObject({
      checkpoint: null,
      escalation: true,
      reasonLabel: 'Failed 3 times',
      sections: ['explanation', 'whatYouCanDo', 'logs'],
    });
    expect(model.whatYouCanDo).toMatch(/approve/i);
  });

  it.each([
    ['escalation', 'Escalated'],
    ['attempts_exhausted', 'Failed 3 times'],
    ['timeout', 'Timed out'],
    ['merge_conflict', 'Merge conflict'],
    ['malformed_output', 'Malformed output'],
  ])('escalation %s is labelled %s and says what you can do', (reason, label) => {
    const model = reviewModel(escalation({ pause_reason: reason }));
    expect(model.reasonLabel).toBe(label);
    expect(model.whatYouCanDo).toEqual(expect.any(String));
    expect(model.whatYouCanDo!.length).toBeGreaterThan(20);
  });

  it('a feature escalation that approves into a merge also shows the delivery', () => {
    const model = reviewModel(checkpoint('final_acceptance', { pause_reason: 'merge_conflict', reject_to: 'in_development' }));
    expect(model.sections).toEqual(['explanation', 'whatYouCanDo', 'delivery']);
  });
});

describe('reviewModel: Send back (J6)', () => {
  it('reject_to null → canSendBack false, with the explanation text', () => {
    const model = reviewModel(escalation({ reject_to: null }));
    expect(model.canSendBack).toBe(false);
    expect(model.noSendBackText).toBe('Approving is the only way forward for this kind of pause.');
    expect(model.sendBackText).toBeNull();
  });

  it('reject_to set → canSendBack true, saying where the work goes', () => {
    expect(reviewModel(checkpoint('after_pm_refinement'))).toMatchObject({
      canSendBack: true,
      noSendBackText: null,
      sendBackText: 'This goes back to the Product Manager with your note.',
    });
    expect(reviewModel(checkpoint('after_ticket_breakdown')).sendBackText).toBe(
      'This goes back to the Delivery Lead with your note.',
    );
    expect(reviewModel(checkpoint('final_acceptance')).sendBackText).toBe(
      'This goes back to development with your note.',
    );
    expect(reviewModel(escalation({ reject_to: 'in_progress' })).sendBackText).toBe(
      'This goes back to the Developer with your note.',
    );
  });

  it('resume_to null → canApprove false, with the reason', () => {
    const model = reviewModel(escalation({ resume_to: null }));
    expect(model.canApprove).toBe(false);
    expect(model.noApproveText).toMatch(/cannot be approved/);
  });
});

describe('reviewModel: the merge confirm', () => {
  it("resume_to 'done' → needsMergeConfirm true, at the checkpoint and after a failed merge", () => {
    expect(reviewModel(checkpoint('final_acceptance')).needsMergeConfirm).toBe(true);
    expect(reviewModel(checkpoint('final_acceptance', { pause_reason: 'merge_conflict' })).needsMergeConfirm).toBe(true);
  });

  it('the route back after a refused close does not merge, so it has no merge confirm', () => {
    const model = reviewModel(
      checkpoint('final_acceptance', { pause_reason: 'escalation', resume_to: 'awaiting_feature_close' }),
    );
    expect(model.needsMergeConfirm).toBe(false);
  });

  it('a ticket never needs the merge confirm', () => {
    expect(reviewModel(escalation({ resume_to: 'done' })).needsMergeConfirm).toBe(false);
  });

  it('the confirm names the branch and the base', () => {
    expect(mergeConfirmText({ featureBranch: 'feature/calculator', baseBranch: 'main' })).toBe(
      'This merges feature/calculator into main and tags it. Continue?',
    );
  });
});

describe('what the page says after a click', () => {
  const ok = { id: 'FEAT-CALC', kind: 'feature' as const, from: 'needs_human', path: '/x' };

  it('held: true is the standing approval, in those words', () => {
    expect(STANDING_APPROVAL).toBe(
      'Your approval is held — the checks will re-run on the new main and the feature will be delivered without asking you again.',
    );
    const out = approveOutcome({ ...ok, to: 'awaiting_feature_close', held: true }, checkpoint('final_acceptance'));
    expect(out).toMatchObject({ tone: 'waiting', message: STANDING_APPROVAL });
  });

  it('held: false on the route back after a refusal claims nothing is held', () => {
    const item = checkpoint('final_acceptance', { pause_reason: 'escalation', resume_to: 'awaiting_feature_close' });
    const out = approveOutcome({ ...ok, to: 'awaiting_feature_close', held: false }, item);
    expect(out.message).not.toMatch(/held|without asking/i);
    expect(out.message).toMatch(/checked again/);
  });

  it('checkpoint approvals say what started', () => {
    expect(approveOutcome({ ...ok, to: 'planning', held: false }, checkpoint('after_pm_refinement')).message).toBe(
      'Approved. Planning has started.',
    );
    expect(approveOutcome({ ...ok, to: 'in_development', held: false }, checkpoint('after_ticket_breakdown')).message).toBe(
      'Approved. Development has started.',
    );
  });

  it("'done' is Delivered, with the tag when it is known", () => {
    expect(approveOutcome({ ...ok, to: 'done', held: false }, checkpoint('final_acceptance'))).toMatchObject({
      tone: 'done',
      title: 'Delivered',
    });
    expect(deliveredMessage({ featureBranch: 'feature/calc', baseBranch: 'main', tag: 'factory/calc/2026-09-24' })).toBe(
      'feature/calc is merged into main and tagged factory/calc/2026-09-24.',
    );
    expect(deliveredMessage({ featureBranch: 'feature/calc', baseBranch: 'main', tag: null })).toBe(
      'feature/calc is merged into main.',
    );
  });

  it('in external mode the outcome adds when the factory picks it up', () => {
    const out = approveOutcome({ ...ok, to: 'planning', held: false }, checkpoint('after_pm_refinement'), {
      external: true,
      pollIntervalSec: 15,
    });
    expect(out.message).toBe('Approved. Planning has started. The factory will pick this up within 15 s.');
    expect(rejectOutcome(checkpoint('after_pm_refinement'), { external: true, pollIntervalSec: 5 }).message).toBe(
      'Sent back to the Product Manager with your note. The factory will pick this up within 5 s.',
    );
  });
});

describe('classifyFailure', () => {
  it('a 409 "not needs_human" is Already handled, not an error', () => {
    expect(
      classifyFailure(409, 'FEAT-CALC is planning, not needs_human. There is nothing to approve — the factory only pauses…'),
    ).toBe('handled');
  });

  it.each([
    [409, 'FEAT-CALC could not be merged: feature/calc conflicts with main in src/a.ts.'],
    [409, 'the feature branch moved since the checks ran'],
    [400, 'a rejection needs a reason'],
    [500, 'internal error'],
    [0, 'The dashboard server is not answering.'],
  ])('%s %s is an error shown as it is', (status, message) => {
    expect(classifyFailure(status, message)).toBe('error');
  });
});

describe('sendBackControl (Phase 8 review fix 1)', () => {
  it('is disabled with the hint while the note is blank', () => {
    const model = reviewModel(checkpoint('after_pm_refinement'));
    for (const note of ['', '   ', '\n\t ']) {
      expect(sendBackControl(model, note), JSON.stringify(note)).toEqual({
        show: true,
        disabled: true,
        hint: 'Write a note to send it back.',
      });
    }
  });

  it('is enabled once the note has text, and says where the work goes', () => {
    const model = reviewModel(checkpoint('after_pm_refinement'));
    expect(sendBackControl(model, 'keep the API shape')).toEqual({
      show: true,
      disabled: false,
      hint: 'This goes back to the Product Manager with your note.',
    });
  });

  it('is not shown where sending back is impossible, whatever the note', () => {
    const model = reviewModel(escalation({ reject_to: null }));
    expect(sendBackControl(model, 'anything')).toEqual({
      show: false,
      disabled: true,
      hint: 'Approving is the only way forward for this kind of pause.',
    });
  });
});
