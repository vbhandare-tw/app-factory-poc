import { pill } from '../components/pill.js';
import { cwdFromInitLine, duration, money, parseRunId, relativizePaths, roleLabel } from '../format.js';
import { append, html, markdown, patch, prepend, setHtml } from '../render.js';
import { href } from '../routes.js';
import { planChunk } from '../store.js';
import { notFound, problem } from './shared.js';

const FOLLOW_SLACK_PX = 48;

export function mount(outlet, route, { api }) {
  const runId = route.runId;
  const meta = parseRunId(runId);
  const base = `/api/runs/${encodeURIComponent(runId)}/transcript`;

  let alive = true;
  let sync = null;
  let firstLine = 0;
  let finished = false;
  let end = null;
  let follow = true;
  let raw = false;
  let rawFirst = 0;
  let unseen = 0;
  let liveSinceRaw = 0;
  let error = null;
  let chain = Promise.resolve();
  let cwd;

  setHtml(
    outlet,
    html`<div class="page run-page">
      <header class="page-head">
        <p class="crumbs"><a href="#/">Overview</a> <span aria-hidden="true">/</span>
          ${meta ? html`<a class="mono" href="${href({ name: 'item', id: meta.itemId })}">${meta.itemId}</a> <span aria-hidden="true">/</span>` : ''}
          <span class="mono">${runId}</span></p>
        <div class="title-row"><h1>${meta ? `${roleLabel(meta.role)} · attempt ${meta.attempt}` : 'Agent run'}</h1><span data-region="state"></span></div>
        <div class="toolbar">
          <button type="button" class="btn btn-small" data-action="raw" aria-pressed="false">Show raw log</button>
          <span class="muted small" data-region="rawnote" aria-live="polite"></span>
        </div>
      </header>
      <div data-region="problem"></div>
      <div data-region="earlier"></div>
      <ol class="steps" aria-live="off"></ol>
      <pre class="code raw-log" tabindex="0" hidden></pre>
      <div data-region="foot"></div>
      <button type="button" class="btn jump" data-action="jump" hidden>New steps below ↓</button>
    </div>`,
  );
  const list = outlet.querySelector('.steps');
  const rawPre = outlet.querySelector('.raw-log');
  const jump = outlet.querySelector('[data-action="jump"]');
  const rawButton = outlet.querySelector('[data-action="raw"]');

  const nearBottom = () =>
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - FOLLOW_SLACK_PX;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });

  const drawChrome = () => {
    patch(outlet, 'state', finished ? (end?.ok === false ? pill('Failed', 'failed') : pill('Finished', 'done')) : pill('Live', 'running'));
    const shownFirst = raw ? rawFirst : firstLine;
    patch(
      outlet,
      'earlier',
      shownFirst > 0
        ? html`<button type="button" class="btn btn-small earlier" data-action="earlier">Show earlier steps</button>`
        : html``,
    );
    patch(
      outlet,
      'foot',
      end === null
        ? finished || error !== null
          ? html``
          : html`<p class="muted small run-waiting">Waiting for the next step…</p>`
        : html`<div class="run-foot ${end.ok ? 'tone-done-soft' : 'tone-failed-soft'}">
            <strong>${end.ok ? 'Finished' : 'Ended with a failure'}</strong>
            ${typeof end.durationMs === 'number' ? html`<span>took <span class="num">${duration(end.durationMs)}</span></span>` : ''}
            ${typeof end.costUsd === 'number' ? html`<span>cost <span class="num">${money(end.costUsd)}</span></span>` : ''}
            ${typeof end.turns === 'number' ? html`<span><span class="num">${end.turns}</span> turns</span>` : ''}
            ${end.reason && end.reason !== 'completed' ? html`<span class="muted">${end.reason}</span>` : ''}
          </div>`,
    );
    patch(outlet, 'rawnote', raw && liveSinceRaw > 0 ? html`${liveSinceRaw} new step${liveSinceRaw === 1 ? '' : 's'} since this snapshot. <button type="button" class="link-button" data-action="raw-refresh">Refresh</button>` : html``);
    patch(outlet, 'problem', error === null ? html`` : error.status === 404 ? notFound('Run', error.message) : problem('Could not load this run', error.message));
  };

  const addSteps = (steps, where) => {
    const endStep = steps.find((s) => s.kind === 'end');
    if (endStep !== undefined) {
      end = endStep;
      finished = true;
    }
    const markup = html`${steps.filter((s) => s.kind !== 'end').map((s) => stepHtml(s, cwd ?? null))}`;
    if (where === 'replace') setHtml(list, markup);
    else if (where === 'prepend') prepend(list, markup);
    else append(list, markup);
  };

  const loadPage = async (before) => {
    const res = await api(before === undefined ? base : `${base}?before=${before}`, { quiet: true });
    end = null;
    finished = res.finished;
    addSteps(res.steps, 'replace');
    firstLine = res.firstLine;
    error = null;
    return res;
  };

  const run = (task) => {
    chain = chain.then(task).catch((e) => {
      error = e;
    }).then(() => {
      if (alive) drawChrome();
    });
    return chain;
  };

  const learnCwd = async () => {
    if (cwd !== undefined) return;
    try {
      const first = await api(`${base}?before=1&raw=1`, { quiet: true });
      cwd = cwdFromInitLine(first.rawLines?.[0]);
    } catch {
      cwd = null;
    }
  };

  const reloadTail = () =>
    run(async () => {
      await learnCwd();
      const res = await loadPage(undefined);
      sync = { mode: 'page', lastLine: res.lastLine };
      if (alive && follow && !finished) toBottom();
      if (raw) await loadRaw();
    });

  const onChunk = (frame) =>
    run(async () => {
      if (sync === null) return;
      let plan = planChunk(sync, frame.firstLine);
      if (plan.action === 'resync') {
        await loadPage(plan.before);
        plan = planChunk({ mode: 'page', lastLine: plan.before }, frame.firstLine);
      }
      addSteps(frame.steps, 'append');
      sync = plan.next;
      if (raw) liveSinceRaw += frame.steps.length;
      if (follow) toBottom();
      else {
        unseen += frame.steps.length;
        jump.textContent = `${unseen} new step${unseen === 1 ? '' : 's'} below ↓`;
        jump.hidden = false;
      }
    });

  const loadRaw = async (before) => {
    const res = await api(`${base}?raw=1${before === undefined ? '' : `&before=${before}`}`, { quiet: true });
    const lines = res.rawLines ?? [];
    if (before === undefined) {
      rawPre.textContent = lines.join('\n');
      liveSinceRaw = 0;
    } else {
      rawPre.textContent = `${lines.join('\n')}\n${rawPre.textContent}`;
    }
    rawFirst = res.firstLine;
  };

  const showEarlier = () =>
    run(async () => {
      const height = document.documentElement.scrollHeight;
      if (raw) {
        await loadRaw(rawFirst);
      } else {
        const res = await api(`${base}?before=${firstLine}`, { quiet: true });
        addSteps(res.steps, 'prepend');
        firstLine = res.firstLine;
      }
      window.scrollBy(0, document.documentElement.scrollHeight - height);
    });

  const setRaw = (on) =>
    run(async () => {
      raw = on;
      rawButton.setAttribute('aria-pressed', String(on));
      rawButton.textContent = on ? 'Show readable steps' : 'Show raw log';
      list.hidden = on;
      rawPre.hidden = !on;
      if (on) await loadRaw();
    });

  const onClick = (event) => {
    const target = event.target.closest('[data-action]');
    if (target === null || !outlet.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'earlier') void showEarlier();
    else if (action === 'raw') void setRaw(!raw);
    else if (action === 'raw-refresh') void run(() => loadRaw());
    else if (action === 'jump') {
      follow = true;
      toBottom();
    }
  };

  const onScroll = () => {
    follow = nearBottom();
    if (follow) {
      unseen = 0;
      jump.hidden = true;
    }
  };

  outlet.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { passive: true });
  void reloadTail().then(() => {
    if (finished) {
      follow = false;
      window.scrollTo(0, 0);
    }
  });

  return {
    update(reason) {
      if (reason === 'reconnect') void reloadTail();
    },
    onTranscript(frame) {
      if (frame.runId === runId) void onChunk(frame);
    },
    destroy() {
      alive = false;
      outlet.removeEventListener('click', onClick);
      window.removeEventListener('scroll', onScroll);
    },
  };
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function stepHtml(step, cwd) {
  switch (step.kind) {
    case 'start':
      return html`<li class="step step-start"><span class="step-mark" aria-hidden="true">▸</span><span>Started${step.model ? html` with <code>${step.model}</code>` : ''}</span></li>`;
    case 'say':
      return html`<li class="step step-say"><div class="prose">${markdown(step.text)}</div></li>`;
    case 'think':
      return html`<li class="step step-think"><details><summary>Thinking</summary><div class="prose">${markdown(step.text)}</div></details></li>`;
    case 'tool':
      return html`<li class="step step-tool"><details><summary><span class="mono">${relativizePaths(step.summary || step.name, cwd)}</span></summary><pre class="code">${pretty(step.input)}</pre></details></li>`;
    case 'tool_result':
      return html`<li class="step step-result ${step.ok ? 'is-ok' : 'is-fail'}"><details><summary>${step.ok ? 'Result' : 'Error'}${step.truncated ? ' (shortened)' : ''}</summary><pre class="code">${step.preview}</pre></details></li>`;
    case 'deliver':
      return html`<li class="step step-deliver"><span class="step-mark" aria-hidden="true">✓</span><span>Handed in its result${step.attempt > 1 ? ` (attempt ${step.attempt})` : ''}</span></li>`;
    default:
      return html`<li class="step step-unknown"><details><summary>Unrecognised step</summary><pre class="code">${step.raw ?? pretty(step)}</pre></details></li>`;
  }
}
