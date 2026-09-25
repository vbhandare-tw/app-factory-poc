import { unwrapMarkdownFence } from '../components/markdown.js';
import { stagePill } from '../components/pill.js';
import { stageStrip } from '../components/stageStrip.js';
import { TICKET_COLUMNS, money, pendingDependencies, shortTicketId, stageLabel } from '../format.js';
import { html, patch, setHtml } from '../render.js';
import { FEATURE_TABS, href } from '../routes.js';
import { createRefresher } from '../store.js';
import { history, loading, noteBlock, notFound, problem, sectionText, waitingCallout } from './shared.js';

const TAB_LABELS = { overview: 'Overview', plan: 'Plan', tickets: 'Tickets', history: 'History' };

export function mount(outlet, route, { api }) {
  let current = route;
  let data = null;
  let error = null;
  let alive = true;

  setHtml(
    outlet,
    html`<div class="page">
      <div data-region="head">${loading('the feature')}</div>
      <nav class="tabs" aria-label="Feature sections" data-region="tabs"></nav>
      <div data-region="panel"></div>
    </div>`,
  );

  const draw = () => {
    if (error !== null) {
      patch(outlet, 'head', error.status === 404 ? notFound('Feature', error.message) : problem('Could not load this feature', error.message));
      patch(outlet, 'tabs', html``);
      patch(outlet, 'panel', html``);
      return;
    }
    if (data === null) return;
    patch(outlet, 'head', header(data));
    patch(outlet, 'tabs', tabs(current));
    patch(outlet, 'panel', panel(current.tab, data));
  };

  const load = async () => {
    try {
      data = await api(`/api/features/${encodeURIComponent(current.slug)}`, { quiet: true });
      error = null;
    } catch (e) {
      if (data === null || e.status === 404) error = e;
    }
    if (alive) draw();
  };
  const reload = createRefresher(load, () => undefined);
  void reload();

  return {
    setRoute(next) {
      current = next;
      draw();
    },
    update() {
      void reload();
    },
    destroy() {
      alive = false;
    },
  };
}

function header(data) {
  const f = data.frontmatter;
  const spend = (f.cost_usd ?? 0) + (data.tickets ?? []).reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  return html`<header class="page-head">
    <p class="crumbs"><a href="#/">Overview</a> <span aria-hidden="true">/</span> <span class="mono">${f.id}</span></p>
    <div class="title-row"><h1>${f.title}</h1>${stagePill(f.status)}</div>
    <dl class="facts">
      <div><dt>Priority</dt><dd>${f.priority}</dd></div>
      <div><dt>Spend</dt><dd class="num">${money(spend)}</dd></div>
      <div><dt>Tickets</dt><dd class="num">${(data.tickets ?? []).length}</dd></div>
      ${f.tag ? html`<div><dt>Tag</dt><dd class="mono">${f.tag}</dd></div>` : ''}
    </dl>
    ${stageStrip(f.status, f.resume_to, f.pause_reason)}
    ${waitingCallout(f)}
  </header>`;
}

function tabs(route) {
  return html`<ul>${FEATURE_TABS.map(
    (tab) => html`<li><a href="${href({ name: 'feature', slug: route.slug, tab })}" ${tab === route.tab ? html`aria-current="page"` : ''}>${TAB_LABELS[tab]}</a></li>`,
  )}</ul>`;
}

function panel(tab, data) {
  switch (tab) {
    case 'plan':
      return planTab(data);
    case 'tickets':
      return board(data.tickets ?? []);
    case 'history':
      return history(data.history ?? []);
    default:
      return overviewTab(data.sections);
  }
}

function overviewTab(sections) {
  const notes = sectionText(sections, 'Notes');
  return html`
    ${noteBlock('Your request', request(sectionText(sections, 'Raw Requirement')), 'No request recorded.')}
    ${noteBlock('Refined by the Product Manager', sectionText(sections, 'Refined Requirement'), 'Not written yet. The Product Manager refines the request first.')}
    ${noteBlock('Acceptance criteria', sectionText(sections, 'Acceptance Criteria'), 'Not written yet. They come with the refined requirement.', 'checklist')}
    ${notes === null ? '' : noteBlock('Notes', notes, '')}`;
}

function request(raw) {
  return raw === null ? null : (unwrapMarkdownFence(raw) ?? raw);
}

function planTab(data) {
  const plan = data.techPlan ?? sectionText(data.sections, 'Tech Plan');
  return noteBlock('Tech Lead’s plan', plan, 'No plan yet. The Tech Lead plans the feature after you approve the refined requirement.');
}

function board(tickets) {
  if (tickets.length === 0) {
    return html`<div class="card"><p class="muted">No tickets yet. The Delivery Lead breaks the plan into tickets after you approve it.</p></div>`;
  }
  const sorted = [...tickets].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return html`<div class="board" aria-label="Tickets by stage">${TICKET_COLUMNS.map((state) => {
    const cards = sorted.filter((t) => t.status === state);
    return html`<section class="column ${cards.length === 0 ? 'is-empty' : ''}" aria-label="${stageLabel(state)}: ${cards.length}">
      <h3>${stageLabel(state)} <span class="count num">${cards.length}</span></h3>
      <ul>${cards.map(
        (t) => html`<li><a class="ticket-card ${state === 'needs_human' ? 'tone-waiting-soft' : ''}" href="${href({ name: 'item', id: t.id })}">
          <span class="ticket-title">${t.title}</span>
          <span class="ticket-meta"><span class="mono" title="${t.id}">${shortTicketId(t.id)}</span>
            ${(t.attempts ?? 0) > 0 ? html`<span>Attempt <span class="num">${t.attempts}</span>${t.max_attempts ? html` of <span class="num">${t.max_attempts}</span>` : ''}</span>` : ''}
            <span class="num">${money(t.cost_usd)}</span></span>
          ${waitingOn(t, tickets)}
        </a></li>`,
      )}</ul>
    </section>`;
  })}</div>`;
}

function waitingOn(ticket, tickets) {
  if (ticket.status === 'done') return '';
  const pending = pendingDependencies(ticket.depends_on, tickets);
  return pending.length === 0 ? '' : html`<span class="ticket-deps muted small">Waits for ${pending.join(', ')}</span>`;
}
