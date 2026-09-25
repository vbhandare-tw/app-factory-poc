import { stageClass, stageLabel } from '../format.js';
import { html } from '../render.js';

export function stagePill(stage) {
  return html`<span class="pill ${stageClass(stage)}">${stageLabel(stage)}</span>`;
}

/** `tone` is one of format.js TONES. */
export function pill(text, tone = 'neutral') {
  return html`<span class="pill tone-${tone}">${text}</span>`;
}
