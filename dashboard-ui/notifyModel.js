/** Which waiting items raise a desktop notification, and when to offer them (J7). Pure: notify.js does the browser part. */
import { pauseLabel } from './format.js';
import { checkpointOf } from './reviewModel.js';

/** `seen` null is the first snapshot, which only primes: nothing already waiting on page load notifies. */
export function diffWaiting(seen, ids) {
  const current = [...new Set(ids)];
  if (seen === null) return { fresh: [], seen: current };
  const before = new Set(seen);
  return { fresh: current.filter((id) => !before.has(id)), seen: current };
}

export function bannerVisible({ supported, permission, dismissed, waiting }) {
  return supported && permission === 'default' && !dismissed && waiting > 0;
}

function sentence(project, text) {
  return project ? `${project}: ${text}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function notificationFor(item, project) {
  let text;
  switch (checkpointOf(item)) {
    case 'after_pm_refinement':
      text = "the PM's requirement is ready for your review.";
      break;
    case 'after_ticket_breakdown':
      text = 'the tickets are ready for your review.';
      break;
    case 'final_acceptance':
      text = `${item.title} is ready for final acceptance.`;
      break;
    default:
      text = `${item.title} needs you (${pauseLabel(item.pause_reason) || 'needs a decision'}).`;
  }
  return { title: 'App Factory', body: sentence(project, text), tag: item.id };
}
