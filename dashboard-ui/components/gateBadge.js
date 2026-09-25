import { html } from '../render.js';

const GATE_TONES = { pass: 'done', fail: 'failed', skipped: 'neutral' };
const GATE_WORDS = { pass: 'passed', fail: 'failed', skipped: 'skipped' };

export function gateBadge(gate, status) {
  const tone = GATE_TONES[status] ?? 'neutral';
  const word = GATE_WORDS[status] ?? String(status ?? 'not run');
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✕' : '–';
  return html`<span class="gate pill tone-${tone}"><span aria-hidden="true">${mark}</span> ${gate} ${word}</span>`;
}
