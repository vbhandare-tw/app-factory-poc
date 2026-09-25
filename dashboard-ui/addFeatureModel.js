/** The add-feature form's rules (J2): one feature at a time until M4 (plan A9), and no reused name. */
import { stageLabel } from './format.js';
import { previewFeatureName } from './slug.js';

/** Mirrors DEMO_ADD_FEATURE_REFUSAL in src/dashboard/constants.ts (checked by add-feature-model.test.ts). */
export const DEMO_REFUSAL = 'The demo runs one scripted feature. Use `factory dashboard` on a real project to add your own.';

const STILL = {
  intake: 'waiting to be picked up',
  refining: 'being refined',
  planning: 'being planned',
  ticketing: 'being split into tickets',
  in_development: 'in development',
  awaiting_feature_close: 'at the final check',
  needs_human: 'waiting for you',
};

export function blockingFeature(features) {
  return (features ?? []).find((f) => f.status !== 'done') ?? null;
}

export function blockedText(feature) {
  const where = Object.hasOwn(STILL, feature.status) ? STILL[feature.status] : `at the ${stageLabel(feature.status)} stage`;
  return (
    `The factory builds one feature at a time for now. ${feature.title} is still ${where}. ` +
    'Finish it (or let it be delivered) before adding the next one.'
  );
}

export function draftState({ name, requirement }, features, { demo = false } = {}) {
  const preview = previewFeatureName(name);
  const blocker = blockingFeature(features);
  const duplicate = preview === null ? null : ((features ?? []).find((f) => f.slug === preview.slug) ?? null);
  const filled = String(name ?? '').trim() !== '' && String(requirement ?? '').trim() !== '';
  return {
    preview,
    blocker,
    duplicate,
    demoBlocked: demo,
    canSubmit: !demo && filled && preview !== null && blocker === null && duplicate === null,
  };
}
