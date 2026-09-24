import { showToast } from './components/toast.js';
import { stagePill } from './components/pill.js';
import { money, pauseLabel } from './format.js';
import { html, patch, setHtml } from './render.js';
import { href, parseRoute } from './routes.js';
import { createRefresher, createStore, mergeActivity, selectWaitingCount } from './store.js';
import * as featureView from './views/feature.js';
import * as overviewView from './views/overview.js';
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
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** GET a dashboard endpoint. A `{message}` error becomes a toast unless `quiet`. */
async function api(path, { quiet = false, text = false } = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'X-Factory-Token': token }, cache: 'no-store' });
  } catch {
    const error = new ApiError(0, 'The dashboard server is not answering. Is the `factory` command still running?');
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
  return { label: 'Stopped', tone: 'idle' };
}

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
  const external = status?.mode === 'external';
  const hosted = status?.mode === 'hosted';
  const why = external
    ? 'The factory is running in another window, so it can only be started and stopped there.'
    : 'Starting and stopping from the page comes in the next update. Use factory start / Ctrl-C in the terminal.';
  patch(
    document,
    'factory',
    html`<span class="light tone-${factory.tone}" aria-hidden="true"></span>
      <span class="factory-label">${factory.label}</span>
      ${status?.killed ? html`<span class="pill tone-waiting">New work paused</span>` : ''}
      <button type="button" class="btn btn-small" disabled title="${why}">${hosted ? 'Stop' : 'Start'}</button>`,
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
          (f) => html`<li><a class="nav-feature" href="${href({ name: 'feature', slug: f.slug, tab: 'overview' })}"
              ${f.slug === current ? html`aria-current="page"` : ''}><span class="nav-title">${f.title}</span>${stagePill(f.status)}</a></li>`,
        )}`,
  );
}

const placeholderViews = {
  new: {
    mount(outlet) {
      setHtml(
        outlet,
        html`<div class="page"><h1>Add a feature</h1>
          <div class="panel"><p>Adding a feature from the page comes in the next update.</p>
          <p>For now, write the requirement in a file and run <code>factory feature add &lt;file&gt;</code> in a terminal. It shows up here as soon as it is added.</p></div></div>`,
      );
      return {};
    },
  },
  review: {
    mount(outlet, route) {
      const draw = (state) => {
        const item = (state.status?.needs_human ?? []).find((i) => i.id === route.id);
        setHtml(
          outlet,
          item === undefined
            ? html`<div class="page"><h1>Review ${route.id}</h1><div class="panel"><p>${state.status === null ? 'Loading…' : 'Already handled: this item is not waiting for you any more.'}</p>
                <p><a href="${href({ name: 'item', id: route.id })}">Open ${route.id}</a></p></div></div>`
            : html`<div class="page"><h1>Review: ${item.title}</h1>
                <div class="callout tone-waiting"><div><strong>${pauseLabel(item.pause_reason)}</strong>${item.pause_detail ? html`<p>${item.pause_detail}</p>` : ''}</div></div>
                <div class="panel"><p>Approving and sending back from the page comes in the next update. For now, in a terminal:</p>
                <pre class="code">factory approve ${item.id}${item.reject_to ? html`\nfactory reject ${item.id} "what to change"` : ''}</pre>
                <p><a href="${href({ name: 'item', id: item.id })}">Open ${item.id}</a></p></div></div>`,
        );
      };
      draw(store.get());
      const unsubscribe = store.subscribe(draw);
      return { destroy: unsubscribe };
    },
  },
};

const VIEWS = {
  overview: overviewView,
  feature: featureView,
  item: ticketView,
  run: runView,
  ...placeholderViews,
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
  view = VIEWS[route.name].mount(outlet, route, { api, store, toast: showToast });
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
window.addEventListener('hashchange', onRoute);
onRoute();
void refreshState();
