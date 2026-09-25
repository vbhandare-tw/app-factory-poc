import { FEATURE_STRIP, stageLabel, stripPosition } from '../format.js';
import { html } from '../render.js';

/** The feature progress strip; at a pause the stage waiting on you is lit in the waiting colour. */
export function stageStrip(status, resumeTo = null, pauseReason = null, { compact = false } = {}) {
  const { at, waiting } = stripPosition(status, resumeTo, pauseReason);
  const current = at < 0 ? null : FEATURE_STRIP[at];
  const label = waiting
    ? `Progress: waiting for you${current === null ? '' : ` at ${stageLabel(current)}`}`
    : `Progress: ${stageLabel(status)}`;
  const steps = FEATURE_STRIP.map((stage, i) => {
    const state = status === 'done' || i < at ? 'done' : i === at ? (waiting ? 'waiting' : 'current') : 'todo';
    return html`<li class="strip-step is-${state}"${i === at ? html` aria-current="step"` : ''}><span class="strip-label">${stageLabel(stage)}</span></li>`;
  });
  return html`<ol class="strip${compact ? ' strip-compact' : ''}" aria-label="${label}">${steps}</ol>`;
}
