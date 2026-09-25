/**
 * What the review page shows and allows for one waiting item (J5, J6). Pure:
 * review.js renders it. CHECKPOINT_ROUTES mirrors src/orchestrator/checkpoints.ts;
 * test/unit/dashboard-ui/review-model.test.ts fails if they drift.
 */
import { pauseLabel, stageLabel } from './format.js';

export const CHECKPOINT_ROUTES = Object.freeze({
  after_pm_refinement: Object.freeze({ resumeTo: 'planning', rejectTo: 'refining' }),
  after_ticket_breakdown: Object.freeze({ resumeTo: 'in_development', rejectTo: 'ticketing' }),
  final_acceptance: Object.freeze({ resumeTo: 'done', rejectTo: 'in_development' }),
});

export const STANDING_APPROVAL =
  'Your approval is held — the checks will re-run on the new main and the feature will be delivered without asking you again.';

const NO_SEND_BACK = 'Approving is the only way forward for this kind of pause.';
const NO_APPROVE = 'This pause cannot be approved from here: fix the item by hand, then start the factory again.';

const CHECKPOINT_VIEW = {
  after_pm_refinement: { question: () => 'Is this what you meant?', sections: ['refined', 'criteria', 'notes'] },
  after_ticket_breakdown: {
    question: () => 'Is this the right split, and can each ticket be built on its own?',
    sections: ['plan', 'tickets'],
  },
  final_acceptance: { question: (base) => `Merge this into ${base}?`, sections: ['delivery'] },
};

const STARTED = { after_pm_refinement: 'Planning has started.', after_ticket_breakdown: 'Development has started.' };

const SEND_BACK_TO = {
  refining: 'the Product Manager',
  planning: 'the Tech Lead',
  ticketing: 'the Delivery Lead',
  in_development: 'development',
  in_progress: 'the Developer',
  ready: 'the ticket queue',
  backlog: 'the ticket queue',
  code_review: 'the Code Reviewer',
  qa: 'QA',
};

const WHAT_YOU_CAN_DO = {
  attempts_exhausted:
    "Read the last agent log and the failing check. Fix what kept failing (the ticket's criteria, the project description or the repo), then approve to try again.",
  escalation: 'Read the explanation above. Fix what it points at, then approve to try again.',
  timeout: 'The agent ran out of time. Check its log for where it got stuck, then approve to try again.',
  merge_conflict: 'Resolve the conflict in the target repo, then approve to try the merge again.',
  malformed_output: "The agent's answer could not be read. Check its log, then approve to run it again.",
};
const WHAT_YOU_CAN_DO_DEFAULT = 'Fix the project description or the repo, then approve to try again.';

function isFeature(item) {
  if (item?.kind === 'feature') return true;
  if (item?.kind === 'ticket') return false;
  return !/-T\d+$/.test(String(item?.id ?? ''));
}

function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

function sendBackTarget(rejectTo) {
  return lookup(SEND_BACK_TO, rejectTo) ?? `the ${stageLabel(rejectTo)} stage`;
}

/** The planned checkpoint a feature is parked at, or null for an escalation or a ticket. */
export function checkpointOf(item) {
  if (item?.pause_reason !== 'checkpoint' || !isFeature(item)) return null;
  const found = Object.entries(CHECKPOINT_ROUTES).find(([, route]) => route.resumeTo === item.resume_to);
  return found === undefined ? null : found[0];
}

export function reviewModel(item, { baseBranch = 'main' } = {}) {
  const checkpoint = checkpointOf(item);
  const canApprove = item.resume_to !== null && item.resume_to !== undefined;
  const canSendBack = item.reject_to !== null && item.reject_to !== undefined;
  const needsMergeConfirm = isFeature(item) && item.resume_to === 'done';
  const escalation = checkpoint === null;

  let sections;
  let question;
  if (escalation) {
    sections = ['explanation', 'whatYouCanDo', needsMergeConfirm ? 'delivery' : 'logs'];
    question = 'What should happen next?';
  } else {
    sections = [...CHECKPOINT_VIEW[checkpoint].sections];
    question = CHECKPOINT_VIEW[checkpoint].question(baseBranch);
  }

  return {
    checkpoint,
    escalation,
    question,
    reasonLabel: pauseLabel(item.pause_reason) || 'Needs a decision',
    sections,
    canApprove,
    noApproveText: canApprove ? null : NO_APPROVE,
    approveLabel: needsMergeConfirm ? 'Approve and merge' : 'Approve',
    canSendBack,
    sendBackText: canSendBack ? `This goes back to ${sendBackTarget(item.reject_to)} with your note.` : null,
    noSendBackText: canSendBack ? null : NO_SEND_BACK,
    needsMergeConfirm,
    whatYouCanDo: escalation
      ? canApprove
        ? (lookup(WHAT_YOU_CAN_DO, item.pause_reason) ?? WHAT_YOU_CAN_DO_DEFAULT)
        : NO_APPROVE
      : null,
  };
}

const WRITE_A_NOTE = 'Write a note to send it back.';

/** Send back needs a note: disabled, with a hint, until the note has text. */
export function sendBackControl(model, note) {
  if (!model.canSendBack) return { show: false, disabled: true, hint: model.noSendBackText };
  const blank = String(note ?? '').trim() === '';
  return { show: true, disabled: blank, hint: blank ? WRITE_A_NOTE : model.sendBackText };
}

export function mergeConfirmText({ featureBranch, baseBranch }) {
  return `This merges ${featureBranch} into ${baseBranch} and tags it. Continue?`;
}

export function deliveredMessage({ featureBranch, baseBranch, tag }) {
  return `${featureBranch} is merged into ${baseBranch}${tag ? ` and tagged ${tag}` : ''}.`;
}

function pickUp(message, { external = false, pollIntervalSec } = {}) {
  return external && Number.isFinite(pollIntervalSec)
    ? `${message} The factory will pick this up within ${pollIntervalSec} s.`
    : message;
}

/** What to say after a successful approve; for `done` the page adds deliveredMessage. */
export function approveOutcome(result, item, options = {}) {
  if (result.to === 'done') return { tone: 'done', title: 'Delivered', message: '' };
  if (result.held === true) return { tone: 'waiting', title: 'Approval held', message: pickUp(STANDING_APPROVAL, options) };
  if (result.to === 'awaiting_feature_close') {
    return {
      tone: 'done',
      title: 'Approved',
      message: pickUp('Approved. The feature goes back to be checked again, and stops for your final approval once the checks pass.', options),
    };
  }
  const started = lookup(STARTED, checkpointOf(item));
  const message = started === undefined ? `Approved. It moves on to ${stageLabel(result.to)}.` : `Approved. ${started}`;
  return { tone: 'done', title: 'Approved', message: pickUp(message, options) };
}

export function rejectOutcome(item, options = {}) {
  return { tone: 'done', title: 'Sent back', message: pickUp(`Sent back to ${sendBackTarget(item.reject_to)} with your note.`, options) };
}

/** `handled`: someone else resolved it first, so it is not an error. Anything else is shown as the server said it. */
export function classifyFailure(status, message) {
  return status === 409 && /\bnot needs_human\b/.test(String(message ?? '')) ? 'handled' : 'error';
}
