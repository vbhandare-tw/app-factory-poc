import { confirmDialog } from './components/confirmDialog.js';
import { showToast } from './components/toast.js';
import { stagePill } from './components/pill.js';
import { money } from './format.js';
import { html, patch } from './render.js';
import { startNotifications } from './notify.js';
import { href, parseRoute } from './routes.js';
import { createRefresher, createStore, mergeActivity, selectWaitingCount } from './store.js';
import * as addFeatureView from './views/add-feature.js';
import * as featureView from './views/feature.js';
import * as overviewView from './views/overview.js';
import * as reviewView from './views/review.js';
import * as runView from './views/run.js';
import * as ticketView from './views/ticket.js';

const ACTIVITY_LIMIT = 100;
const RETRY_MS = 3000;
const RUN_RETRIES = 5;

const token = document.querySelector('meta[name="factory-token"]')?.getAttribute('content') ?? '';

const store = createStore({
  status: null,
  statusError: null,
  activeRuns: [],
  activeFetchedAt: 0,
  activity: [],
  connection: 'connecting',
  justAdded: null,
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NOT_ANSWERING = 'The dashboard server is not answering. Is the `factory` command still running?';

/** GET a dashboard endpoint. A `{message}` error becomes a toast unless `quiet`. */
async function api(path, { quiet = false, text = false } = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'X-Factory-Token': token }, cache: 'no-store' });
  } catch {
    const error = new ApiError(0, NOT_ANSWERING);
    if (!quiet) showToast(error.message);
    throw error;
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body?.message === 'string') message = body.message;
    } catch {
      // not JSON: keep the status line
    }
    const error = new ApiError(res.status, message);
    if (!quiet) showToast(message);
    throw error;
  }
  return text ? res.text() : res.json();
}

/** POST a write. Never toasts: the caller shows the server's `message` where the user acted. */
async function post(path, body = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Factory-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, NOT_ANSWERING);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const error = new ApiError(res.status, typeof json?.message === 'string' ? json.message : `${res.status} ${res.statusText}`);
    error.body = json;
    throw error;
  }
  return json ?? {};
}

const refreshState = createRefresher(
  () => Promise.all([api('/api/state', { quiet: true }), api('/api/runs/active', { quiet: true })]),
  (loaded, error) => {
    if (error !== null) {
      store.set({ statusError: error.message });
      return;
    }
    const [status, active] = loaded;
    store.set({ status, statusError: null, activeRuns: active.runs ?? [], activeFetchedAt: Date.now() });
  },
);

let pendingEvents = null;
async function refreshActivity() {
  const pending = [];
  pendingEvents = pending;
  try {
    const { events } = await api(`/api/activity?limit=${ACTIVITY_LIMIT}`, { quiet: true });
    store.set({ activity: mergeActivity(events ?? [], pending, ACTIVITY_LIMIT) });
  } catch {
    // the feed keeps what it had; the next reconnect refetches
  } finally {
    if (pendingEvents === pending) pendingEvents = null;
  }
}

function onEvent(frame) {
  const event = { ...frame.event, summary: frame.summary };
  if (pendingEvents !== null) pendingEvents.push(event);
  else store.set({ activity: [event, ...store.get().activity].slice(0, ACTIVITY_LIMIT) });
  if (event.type === 'run_started' || event.type === 'run_finished') void refreshState();
}

let source = null;
let sourceRun = null;
let retryTimer = null;
let runRefusals = 0;

function parseFrame(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

/** One EventSource for the page; on the run view it also carries that run's transcript. */
function connect(runId) {
  if (source !== null && sourceRun === runId && source.readyState !== EventSource.CLOSED) return;
  source?.close();
  clearTimeout(retryTimer);
  sourceRun = runId;
  const es = new EventSource(runId === null ? '/api/stream' : `/api/stream?run=${encodeURIComponent(runId)}`);
  source = es;

  es.addEventListener('open', () => {
    store.set({ connection: 'live' });
    void refreshState();
    void refreshActivity();
    view?.update?.('reconnect');
  });
  es.addEventListener('state_changed', (e) => {
    void refreshState();
    view?.update?.('state', parseFrame(e));
  });
  es.addEventListener('event', (e) => {
    const frame = parseFrame(e);
    if (frame !== null) onEvent(frame);
  });
  es.addEventListener('transcript_line', (e) => {
    const frame = parseFrame(e);
    if (frame !== null) view?.onTranscript?.(frame);
  });
  es.addEventListener('error', () => {
    if (es !== source) return;
    store.set({ connection: 'reconnecting' });
    if (es.readyState !== EventSource.CLOSED) return;
    if (runId === null) {
      retryTimer = setTimeout(() => connect(currentRoute.name === 'run' ? currentRoute.runId : null), RETRY_MS);
      return;
    }
    // A refused ?run= (no transcript yet) falls back to the plain stream and tries the run again later.
    runRefusals += 1;
    connect(null);
    if (runRefusals < RUN_RETRIES) {
      retryTimer = setTimeout(() => {
        if (currentRoute.name === 'run' && currentRoute.runId === runId) connect(runId);
      }, RETRY_MS * 3);
    }
  });
}

function projectName(status) {
  if (status === null) return '';
  if (status.project) return status.project;
  if (status.demo) return 'demo';
  const parts = String(status.target_repo ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function factoryState(status) {
  if (status === null) return { label: 'Connecting…', tone: 'neutral' };
  if (status.mode === 'external') return { label: 'Running in another window', tone: 'running' };
  if (status.mode === 'hosted') return status.stopping ? { label: 'Stopping…', tone: 'waiting' } : { label: 'Running', tone: 'done' };
  const failed = (status.startupFailures ?? []).length > 0 || Boolean(status.lastError);
  return { label: 'Stopped', tone: failed ? 'failed' : 'idle' };
}

let shellBusy = false;
let menuOpen = false;

const STOP_CONFIRM = {
  title: 'Stop the factory?',
  message: 'Stop after the current agent finishes? Nothing is lost; you can start again any time.',
  confirmLabel: 'Stop',
};
const STOP_NOW_CONFIRM = {
  title: 'Stop now?',
  message: 'This stops the running agent immediately; the work it was doing on this attempt is lost.',
  confirmLabel: 'Stop now',
  danger: true,
};

function factoryButtons(status) {
  if (status === null) return '';
  const off = shellBusy ? html` disabled` : '';
  let main;
  if (status.mode === 'external') {
    main = html`<button type="button" class="btn btn-small" disabled
      title="The factory is running in another window, so it can only be started and stopped there.">Start</button>`;
  } else if (status.mode === 'hosted' && status.stopping) {
    main = html`<button type="button" class="btn btn-small btn-danger" data-factory="stop-now"${off}>Stop now</button>`;
  } else if (status.mode === 'hosted') {
    main = html`<button type="button" class="btn btn-small" data-factory="stop"${off}>Stop</button>`;
  } else {
    main = html`<button type="button" class="btn btn-small btn-primary" data-factory="start"${off}>Start</button>`;
  }
  const pause = status.killed
    ? html`<button type="button" class="menu-item" data-factory="resume"${off}>Resume new work</button>`
    : html`<button type="button" class="menu-item" data-factory="kill"${off}>Stop taking new work</button>`;
  return html`${main}
    <details class="menu"${menuOpen ? html` open` : ''}><summary class="btn btn-small">More</summary>
      <div class="menu-list">${pause}</div></details>`;
}

async function factoryAction(kind) {
  if (shellBusy) return;
  menuOpen = false;
  shellBusy = true;
  drawShell(store.get());
  const confirm = kind === 'stop' ? STOP_CONFIRM : kind === 'stop-now' ? STOP_NOW_CONFIRM : null;
  if (confirm !== null && !(await confirmDialog(confirm))) {
    shellBusy = false;
    drawShell(store.get());
    return;
  }
  try {
    if (kind === 'start') await post('/api/factory/start');
    else if (kind === 'stop') await post('/api/factory/stop', {});
    else if (kind === 'stop-now') await post('/api/factory/stop', { force: true });
    else if (kind === 'kill') {
      await post('/api/factory/kill');
      showToast('New work paused. A running agent finishes; nothing new starts until you resume new work.', 'done');
    } else if (kind === 'resume') {
      await post('/api/factory/resume');
      showToast('New work resumed.', 'done');
    }
  } catch (error) {
    const failures = Array.isArray(error.body?.failures) ? error.body.failures : [];
    showToast([error.message, ...failures.map((f) => `${f.key}: ${f.message}`)].join('\n'));
  } finally {
    shellBusy = false;
  }
  await refreshState();
  drawShell(store.get());
}

document.addEventListener('click', (event) => {
  const action = event.target.closest?.('[data-factory]')?.dataset.factory;
  if (action !== undefined) {
    event.preventDefault();
    void factoryAction(action);
    return;
  }
  const menu = document.querySelector('.topbar .menu');
  if (menu?.open && !menu.contains(event.target)) {
    menu.open = false;
    menuOpen = false;
  }
});
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.matches?.('.topbar .menu')) menuOpen = event.target.open;
  },
  true,
);

function drawShell(state) {
  const { status } = state;
  const name = projectName(status);
  const waiting = selectWaitingCount(state);
  document.title = `${waiting > 0 ? `(${waiting}) ` : ''}App Factory${name ? ` — ${name}` : ''}`;

  patch(
    document,
    'project',
    html`<span class="project-name">${name}</span>${status?.demo ? html`<span class="badge-demo" title="Scripted agents, no cost">DEMO</span>` : ''}`,
  );

  const factory = factoryState(status);
  patch(
    document,
    'factory',
    html`<span class="light tone-${factory.tone}" aria-hidden="true"></span>
      <span class="factory-label">${factory.label}</span>
      ${status?.killed ? html`<span class="pill tone-waiting">New work paused</span>` : ''}
      ${factoryButtons(status)}`,
  );

  patch(
    document,
    'meta',
    html`<a class="waiting-count ${waiting > 0 ? 'tone-waiting' : ''}" href="#/"
        aria-label="${waiting} item${waiting === 1 ? '' : 's'} waiting for you"><span class="num">${waiting}</span> waiting for you</a>
      <span class="spend">Spent <span class="num">${money(status?.totalCostUsd)}</span></span>
      <span class="conn conn-${state.connection}">${state.connection === 'live' ? 'Live' : state.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>`,
  );

  const features = status?.features ?? [];
  const current = currentRoute.name === 'feature' ? currentRoute.slug : null;
  patch(
    document,
    'nav',
    features.length === 0
      ? html`<li class="muted nav-empty">No features yet</li>`
      : html`${features.map(
          (f) => html`<li><a class="nav-feature${f.slug === state.justAdded ? ' is-new' : ''}" href="${href({ name: 'feature', slug: f.slug, tab: 'overview' })}"
              ${f.slug === current ? html`aria-current="page"` : ''}><span class="nav-title">${f.title}</span>${stagePill(f.status)}</a></li>`,
        )}`,
  );
}

const VIEWS = {
  overview: overviewView,
  feature: featureView,
  item: ticketView,
  run: runView,
  new: addFeatureView,
  review: reviewView,
};

const outlet = document.getElementById('main');
let view = null;
let currentRoute = { name: 'overview' };
let firstRoute = true;

function onRoute() {
  const route = parseRoute(location.hash);
  const sameFeature =
    route.name === 'feature' && currentRoute.name === 'feature' && route.slug === currentRoute.slug && view?.setRoute;
  currentRoute = route;
  drawShell(store.get());
  if (sameFeature) {
    view.setRoute(route);
    return;
  }

  view?.destroy?.();
  runRefusals = 0;
  outlet.replaceChildren();
  view = VIEWS[route.name].mount(outlet, route, { api, post, store, toast: showToast, refreshState });
  connect(route.name === 'run' ? route.runId : null);
  if (!firstRoute) {
    window.scrollTo(0, 0);
    outlet.focus({ preventScroll: true });
  }
  firstRoute = false;
}

document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  outlet.focus();
});
store.subscribe(drawShell);
startNotifications({ store, projectName });
window.addEventListener('hashchange', onRoute);
onRoute();
void refreshState();
