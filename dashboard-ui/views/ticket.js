import { gateBadge } from '../components/gateBadge.js';
import { pill, stagePill } from '../components/pill.js';
import { clockTime, duration, money, relativeTime, roleLabel } from '../format.js';
import { html, patch, setHtml } from '../render.js';
import { href } from '../routes.js';
import { createRefresher } from '../store.js';
import { history, loading, noteBlock, notFound, problem, sectionText, waitingCallout } from './shared.js';

const GATE_ORDER = ['tests', 'lint', 'build'];

export function mount(outlet, route, { api }) {
  let item = null;
  let runs = { runs: [], gateLogs: [] };
  let error = null;
  let alive = true;
  const outputs = new Map();

  setHtml(
    outlet,
    html`<div class="page">
      <div data-region="head">${loading(route.id)}</div>
      <div data-region="notes"></div>
      <section class="card" aria-labelledby="h-gates" data-region="gates"></section>
      <div data-region="runs"></div>
      <div data-region="timeline"></div>
    </div>`,
  );

  const fillOutputs = () => {
    for (const [gate, out] of outputs) {
      const pre = outlet.querySelector(`pre[data-gate-output="${CSS.escape(gate)}"]`);
      if (pre === null) continue;
      const text = out.text ?? (out.error ? `Could not load the output: ${out.error}` : 'Loading…');
      if (pre.textContent !== text) pre.textContent = text;
    }
  };

  const draw = () => {
    if (error !== null) {
      patch(outlet, 'head', error.status === 404 ? notFound('Ticket', error.message) : problem('Could not load this ticket', error.message));
      for (const region of ['notes', 'gates', 'runs', 'timeline']) patch(outlet, region, html``);
      return;
    }
    if (item === null) return;
    patch(outlet, 'head', header(item));
    patch(outlet, 'notes', notes(item.sections));
    patch(outlet, 'gates', gates(item, runs.gateLogs, outputs));
    fillOutputs();
    patch(outlet, 'runs', runList(runs.runs));
    patch(outlet, 'timeline', history(item.history ?? []));
  };

  const load = async () => {
    try {
      const id = encodeURIComponent(route.id);
      const [nextItem, nextRuns] = await Promise.all([
        api(`/api/items/${id}`, { quiet: true }),
        api(`/api/items/${id}/runs`, { quiet: true }),
      ]);
      if (nextItem.kind === 'feature') {
        location.replace(href({ name: 'feature', slug: nextItem.frontmatter.slug, tab: 'overview' }));
        return;
      }
      item = nextItem;
      runs = nextRuns;
      error = null;
    } catch (e) {
      if (item === null || e.status === 404) error = e;
    }
    if (alive) draw();
  };
  const reload = createRefresher(load, () => undefined);
  void reload();

  const redrawKeepingFocus = (gate) => {
    draw();
    outlet.querySelector(`[data-show-output="${CSS.escape(gate)}"]`)?.focus();
  };

  const onClick = async (event) => {
    const button = event.target.closest('[data-show-output]');
    if (button === null || !outlet.contains(button)) return;
    const gate = button.dataset.showOutput;
    if (outputs.has(gate)) {
      outputs.delete(gate);
      redrawKeepingFocus(gate);
      return;
    }
    const out = { text: null, error: null };
    outputs.set(gate, out);
    redrawKeepingFocus(gate);
    const log = [...runs.gateLogs].reverse().find((g) => g.gate === gate);
    const fallback = item?.frontmatter?.gate_results?.[gate]?.output ?? null;
    try {
      if (log === undefined) throw new Error('no output was recorded for this check');
      out.text = await api(`/api/gate-logs/${encodeURIComponent(log.gateLogId)}`, { quiet: true, text: true });
    } catch (e) {
      if (fallback !== null) out.text = fallback;
      else out.error = e.message;
    }
    if (alive) fillOutputs();
  };
  outlet.addEventListener('click', onClick);

  return {
    update() {
      void reload();
    },
    destroy() {
      alive = false;
      outlet.removeEventListener('click', onClick);
    },
  };
}

function header(item) {
  const t = item.frontmatter;
  const attempt =
    (t.attempts ?? 0) === 0 ? (t.status === 'backlog' || t.status === 'ready' ? 'Not started' : '—') : `Attempt ${t.attempts}${t.max_attempts ? ` of ${t.max_attempts}` : ''}`;
  const deps = t.depends_on ?? [];
  return html`<header class="page-head">
    <p class="crumbs"><a href="#/">Overview</a> <span aria-hidden="true">/</span>
      <a href="${href({ name: 'feature', slug: t.feature, tab: 'tickets' })}">${t.feature}</a> <span aria-hidden="true">/</span>
      <span class="mono">${t.id}</span></p>
    <div class="title-row"><h1>${t.title}</h1>${stagePill(t.status)}</div>
    <dl class="facts">
      <div><dt>Attempt</dt><dd class="num">${attempt}</dd></div>
      <div><dt>Spend</dt><dd class="num">${money(t.cost_usd)}</dd></div>
      <div><dt>Waits for</dt><dd>${deps.length === 0 ? 'Nothing' : deps.map((d, i) => html`${i > 0 ? ', ' : ''}<a class="mono" href="${href({ name: 'item', id: d })}">${d}</a>`)}</dd></div>
    </dl>
    ${waitingCallout(t)}
  </header>`;
}

function notes(sections) {
  const extra = sectionText(sections, 'Notes');
  return html`
    ${noteBlock('Acceptance criteria', sectionText(sections, 'Acceptance Criteria'), 'None written.', 'checklist')}
    ${noteBlock('What the Developer did', sectionText(sections, 'Implementation Notes'), 'The Developer has not worked on this yet.')}
    ${noteBlock('Code Reviewer’s findings', sectionText(sections, 'Review Notes'), 'Not reviewed yet.')}
    ${noteBlock('QA’s result', sectionText(sections, 'QA Notes'), 'Not checked by QA yet.')}
    ${extra === null ? '' : noteBlock('Notes', extra, '')}`;
}

function gates(item, gateLogs, outputs) {
  const results = item.frontmatter.gate_results ?? {};
  const names = [...new Set([...GATE_ORDER, ...Object.keys(results), ...gateLogs.map((g) => g.gate)])].filter(
    (gate) => results[gate] !== undefined || gateLogs.some((g) => g.gate === gate),
  );
  const body =
    names.length === 0
      ? html`<p class="muted">No checks have run yet. Tests, lint and build run after the Developer finishes.</p>`
      : html`<ul class="gate-list">${names.map((gate) => {
          const r = results[gate];
          const last = [...gateLogs].reverse().find((g) => g.gate === gate);
          const status = r?.status ?? last?.status;
          const ms = r?.duration_ms ?? last?.durationMs;
          const exit = r?.exit_code ?? last?.exitCode;
          const open = outputs.has(gate);
          return html`<li class="gate-row">
            <div class="gate-line">${gateBadge(gate, status)}
              <span class="muted small">${typeof ms === 'number' ? html`<span class="num">${duration(ms)}</span>` : ''}${typeof exit === 'number' ? html` · exit <span class="num">${exit}</span>` : ''}</span>
              <button type="button" class="link-button" data-show-output="${gate}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Hide output' : 'Show output'}</button>
            </div>
            ${open ? html`<pre class="code gate-output" data-gate-output="${gate}" tabindex="0"></pre>` : ''}
          </li>`;
        })}</ul>`;
  return html`<h2 id="h-gates">Checks</h2>${body}`;
}

function runList(runs) {
  if (runs.length === 0) return html``;
  return html`<section class="card"><h2>Agent runs</h2><ul class="run-list">${[...runs].reverse().map((run) => {
    const state = !run.finished ? pill('Running', 'running') : run.ok ? pill('OK', 'done') : pill('Failed', 'failed');
    return html`<li class="run-row">
      <div class="run-main">
        <p><strong>${roleLabel(run.role)}</strong> <span class="muted">attempt ${run.attempt}</span> ${state}</p>
        <p class="muted small">${run.startedAt ? html`<time datetime="${run.startedAt}" title="${clockTime(run.startedAt)}">${relativeTime(run.startedAt)}</time>` : ''}
          ${run.durationMs !== null ? html` · <span class="num">${duration(run.durationMs)}</span>` : ''}
          ${run.costUsd !== null ? html` · <span class="num">${money(run.costUsd)}</span>` : ''}</p>
      </div>
      <a class="btn" href="${href({ name: 'run', runId: run.runId })}">${run.finished ? 'View log' : 'Watch live'}</a>
    </li>`;
  })}</ul></section>`;
}
