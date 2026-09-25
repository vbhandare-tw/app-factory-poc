import { stagePill } from '../components/pill.js';
import { stageStrip } from '../components/stageStrip.js';
import { clockTime, duration, isRoutineEvent, pauseLabel, relativeTime, roleLabel } from '../format.js';
import { html, patch, setHtml } from '../render.js';
import { href } from '../routes.js';

export function mount(outlet, _route, { store }) {
  let showAll = false;
  setHtml(
    outlet,
    html`<div class="page">
      <h1 class="visually-hidden">Overview</h1>
      <div data-region="problems"></div>
      <div data-region="banner"></div>
      <div data-region="waiting"></div>
      <div class="grid-2">
        <section class="card" aria-labelledby="h-running"><h2 id="h-running">Running now</h2><div data-region="running"></div></section>
        <section class="card" aria-labelledby="h-features"><h2 id="h-features">Features</h2><div data-region="features"></div></section>
      </div>
      <section class="card" aria-labelledby="h-activity">
        <div class="card-head"><h2 id="h-activity">Recent activity</h2>
          <button type="button" class="btn btn-small" data-action="all-activity" aria-pressed="false">Show all activity</button></div>
        <div data-region="activity"></div>
      </section>
    </div>`,
  );

  const draw = (state) => {
    patch(outlet, 'problems', problems(state));
    patch(outlet, 'banner', banner(state.status));
    patch(outlet, 'waiting', waiting(state.status));
    patch(outlet, 'running', running(state));
    patch(outlet, 'features', features(state.status));
    patch(outlet, 'activity', activity(state.activity, showAll));
  };
  draw(store.get());
  const unsubscribe = store.subscribe(draw);
  const tick = setInterval(() => {
    const state = store.get();
    patch(outlet, 'running', running(state));
    patch(outlet, 'activity', activity(state.activity, showAll));
  }, 1000);

  const onClick = (event) => {
    const button = event.target.closest('[data-action="all-activity"]');
    if (button === null) return;
    showAll = !showAll;
    button.setAttribute('aria-pressed', String(showAll));
    button.textContent = showAll ? 'Hide routine events' : 'Show all activity';
    patch(outlet, 'activity', activity(store.get().activity, showAll));
  };
  outlet.addEventListener('click', onClick);

  return {
    destroy() {
      unsubscribe();
      clearInterval(tick);
      outlet.removeEventListener('click', onClick);
    },
  };
}

function problems(state) {
  const { status, statusError } = state;
  const blocks = [];
  if (statusError !== null) {
    blocks.push(html`<div class="panel panel-failed" role="alert">
      <h2>The dashboard cannot read this project</h2>
      <p>${statusError}</p>
      <p class="muted">The terminal running the dashboard has the full error. A broken <code>config.yml</code> in the vault is the usual cause; fix it and this page recovers on its own.</p>
    </div>`);
  }
  if (status === null) return html`${blocks}`;
  const failures = status.startupFailures ?? [];
  if (failures.length > 0) {
    blocks.push(html`<div class="panel panel-failed" role="alert">
      <h2>The factory could not start</h2>
      <p>Fix these in the vault's <code>config.yml</code>, then restart the dashboard (stop it with Ctrl-C and run <code>factory dashboard</code> again). It reads the settings once, when it opens:</p>
      <ul>${failures.map((f) => html`<li><code>${f.key}</code>: ${f.message}</li>`)}</ul>
    </div>`);
  } else if (status.lastError) {
    blocks.push(html`<div class="panel panel-failed" role="alert">
      <h2>The factory stopped with an error</h2>
      <p>${status.lastError}</p>
    </div>`);
  }
  if (status.killed) {
    blocks.push(html`<div class="panel tone-waiting-soft"><p><strong>New work is paused.</strong> Agents already running finish; nothing new starts until new work is resumed.</p></div>`);
  }
  return html`${blocks}`;
}

function banner(status) {
  if (status?.mode !== 'external') return html``;
  return html`<div class="banner" role="status">
    <strong>The factory is running in another window.</strong>
    Start and Stop are turned off here; everything else works.
  </div>`;
}

function waiting(status) {
  const items = status?.needs_human ?? [];
  if (items.length === 0) return html``;
  return html`<section class="waiting" aria-labelledby="h-waiting">
    <h2 id="h-waiting">Waiting for you <span class="count num">${items.length}</span></h2>
    <ul class="wait-list">${items.map(
      (item) => html`<li class="wait-card">
        <div class="wait-main">
          <p class="wait-title"><a href="${href({ name: 'item', id: item.id })}">${item.title}</a> <span class="muted mono">${item.id}</span></p>
          <p class="wait-reason"><span class="pill tone-waiting">${pauseLabel(item.pause_reason) || 'Needs a decision'}</span>
            ${item.pause_detail ? html`<span class="wait-detail">${item.pause_detail}</span>` : ''}</p>
          ${item.paused_at ? html`<p class="muted small">Waiting since <time datetime="${item.paused_at}" title="${clockTime(item.paused_at)}">${relativeTime(item.paused_at)}</time></p>` : ''}
        </div>
        <a class="btn btn-primary" href="${href({ name: 'review', id: item.id })}">Review</a>
      </li>`,
    )}</ul>
  </section>`;
}

function running(state) {
  const runs = state.activeRuns ?? [];
  if (runs.length === 0) {
    const stopped = state.status?.mode === 'stopped';
    return html`<p class="muted">${stopped ? 'Idle. The factory is stopped.' : 'Idle, nothing to do.'}</p>`;
  }
  const since = Date.now() - (state.activeFetchedAt || Date.now());
  return html`<ul class="run-list">${runs.map(
    (run) => html`<li class="run-row">
      <span class="light tone-running pulse" aria-hidden="true"></span>
      <div class="run-main">
        <p><strong>${roleLabel(run.role) || 'An agent'}</strong> working on
          ${run.itemId ? html`<a href="${href({ name: 'item', id: run.itemId })}">${run.itemId}</a>` : 'an item'}
          ${run.attempt ? html`<span class="muted">(attempt ${run.attempt})</span>` : ''}</p>
        <p class="muted small">for <span class="num">${run.elapsedMs === null ? '—' : duration(run.elapsedMs + since)}</span></p>
      </div>
      <a class="btn" href="${href({ name: 'run', runId: run.runId })}">Watch live</a>
    </li>`,
  )}</ul>`;
}

function features(status) {
  if (status === null) return html`<p class="muted" role="status">Loading…</p>`;
  const list = status.features ?? [];
  if (list.length === 0) {
    return html`<div class="empty">
      <p class="empty-title">No features yet</p>
      <p class="muted">Add a feature and the factory takes it from there: the PM refines it, the Tech Lead plans it, and it stops for your approval at each checkpoint.</p>
      <a class="btn btn-primary btn-large" href="#/new">Add your first feature</a>
    </div>`;
  }
  const parked = new Map((status.needs_human ?? []).map((i) => [i.id, i]));
  return html`<ul class="feature-rows">${list.map((f) => {
    const done = f.ticketsByState?.done ?? 0;
    return html`<li class="feature-row">
      <div class="feature-row-head">
        <a class="feature-title" href="${href({ name: 'feature', slug: f.slug, tab: 'overview' })}">${f.title}</a>
        ${stagePill(f.status)}
      </div>
      ${stageStrip(f.status, parked.get(f.id)?.resume_to ?? null, parked.get(f.id)?.pause_reason ?? null, { compact: true })}
      <p class="muted small">${f.tickets === 0 ? 'No tickets yet' : html`<span class="num">${done}</span> of <span class="num">${f.tickets}</span> tickets done`}</p>
    </li>`;
  })}</ul>`;
}

function activity(events, showAll) {
  const all = events ?? [];
  const shown = showAll ? all : all.filter((e) => !isRoutineEvent(e));
  const hidden = all.length - shown.length;
  const note = hidden > 0 ? html`<p class="muted small">${hidden} routine event${hidden === 1 ? '' : 's'} hidden.</p>` : '';
  if (shown.length === 0) return html`<p class="muted">Nothing has happened yet.</p>${note}`;
  return html`<ol class="feed">${shown.map(
    (e) => html`<li><span class="feed-text">${e.summary ?? e.type}</span>
      <time class="muted small" datetime="${e.ts ?? ''}" title="${clockTime(e.ts)}">${relativeTime(e.ts)}</time></li>`,
  )}</ol>${note}`;
}
