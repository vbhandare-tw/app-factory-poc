import { actorLabel, clockTime, pauseLabel, stageLabel } from '../format.js';
import { href } from '../routes.js';
import { html, markdown } from '../render.js';

export function loading(what) {
  return html`<p class="muted" role="status">Loading ${what}…</p>`;
}

export function problem(title, message) {
  return html`<div class="panel panel-failed" role="alert"><h2>${title}</h2><p>${message}</p></div>`;
}

export function notFound(what, message) {
  return html`<div class="panel"><h1>${what} not found</h1><p>${message}</p><p><a href="#/">Back to the overview</a></p></div>`;
}

export function sectionText(sections, heading) {
  const found = (sections ?? []).find((s) => s.heading === heading);
  return found === undefined || found.markdown.trim() === '' ? null : found.markdown;
}

/** One titled block of vault markdown, or a plain "not yet" line. */
export function noteBlock(title, text, empty, extraClass = '') {
  return html`<section class="card">
    <h2>${title}</h2>
    ${text === null ? html`<p class="muted">${empty}</p>` : html`<div class="prose ${extraClass}">${markdown(text)}</div>`}
  </section>`;
}

export function waitingCallout(front) {
  if (front?.status !== 'needs_human') return '';
  return html`<div class="callout tone-waiting">
    <div><strong>Waiting for you: ${pauseLabel(front.pause_reason) || 'needs a decision'}</strong>
    ${front.pause_detail ? html`<p>${front.pause_detail}</p>` : ''}</div>
    <a class="btn btn-primary" href="${href({ name: 'review', id: front.id })}">Review</a>
  </div>`;
}

/** A `## History` timeline, newest first. */
export function history(entries) {
  if (entries.length === 0) return html`<div class="card"><p class="muted">No history yet.</p></div>`;
  return html`<section class="card"><h2>Timeline</h2><ol class="timeline">${[...entries].reverse().map(
    (e) => html`<li>
      <time datetime="${e.ts}">${clockTime(e.ts)}</time>
      <span class="timeline-step">${stageLabel(e.from)} <span aria-hidden="true">→</span><span class="visually-hidden">to</span> ${stageLabel(e.to)}</span>
      <span class="timeline-actor">${actorLabel(e.actor)}</span>
      ${e.note ? html`<div class="timeline-note">${markdown(e.note)}</div>` : ''}
    </li>`,
  )}</ol></section>`;
}
