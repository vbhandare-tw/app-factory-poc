import { confirmDialog } from '../components/confirmDialog.js';
import { gateBadge } from '../components/gateBadge.js';
import { clockTime, relativeTime, roleLabel, shortTicketId } from '../format.js';
import { html, markdown, patch, setHtml } from '../render.js';
import { href } from '../routes.js';
import {
  approveOutcome,
  classifyFailure,
  deliveredMessage,
  mergeConfirmText,
  rejectOutcome,
  reviewModel,
  sendBackControl,
} from '../reviewModel.js';
import { createRefresher } from '../store.js';
import { loading, noteBlock, problem, sectionText } from './shared.js';

const NOTE_KEY = 'review-note';
const EMPTY_REASON = 'Sending back needs a note: say what to change, because the next agent reads it.';
const DID_NOT_STICK =
  'The server accepted your answer, but this item is still waiting at the same point, so the factory may have ' +
  'overwritten it while finishing its last step. Your note is still in the box: check the item’s history, then answer again.';

export function mount(outlet, route, { api, post, store, refreshState }) {
  const id = route.id;
  const enc = encodeURIComponent;
  let alive = true;
  let phase = 'idle';
  let outcome = null;
  let lastItem = null;
  let pauseKey = null;
  let detail = null;
  let loadError = null;
  let tickets = null;
  const ticketDetails = new Map();
  let runs = null;
  let delivery = null;
  let deliveryError = null;
  let deliveryKey = null;

  setHtml(
    outlet,
    html`<div class="page review-page">
      <div data-region="head">${loading(id)}</div>
      <div data-region="body"></div>
      <div data-region="outcome" aria-live="polite"></div>
      <div data-region="reply"></div>
    </div>`,
  );

  const waitingItem = (state) => (state.status?.needs_human ?? []).find((i) => i.id === id) ?? null;
  const noteField = () => outlet.querySelector(`[data-keep="${NOTE_KEY}"]`);
  const baseBranch = () => store.get().status?.base_branch ?? 'main';
  const branches = () => ({
    featureBranch:
      delivery?.featureBranch ?? detail?.frontmatter?.feature_branch ?? `feature/${detail?.frontmatter?.slug ?? id}`,
    baseBranch: delivery?.baseBranch ?? baseBranch(),
  });

  const draw = () => {
    if (!alive) return;
    const state = store.get();
    const waiting = waitingItem(state);
    if (waiting !== null) lastItem = waiting;
    const settled = outcome?.kind === 'success' || outcome?.kind === 'handled';
    if (settled && waiting !== null && waiting.paused_at !== outcome.pausedAt) outcome = null;
    const item = waiting ?? lastItem;

    if (item === null) {
      patch(outlet, 'head', state.status === null ? loading(id) : html`<header class="page-head"><h1>Review ${id}</h1></header>`);
      patch(outlet, 'body', html``);
    } else {
      const model = reviewModel(item, { baseBranch: baseBranch() });
      patch(outlet, 'head', header(item, model, waiting !== null));
      patch(outlet, 'body', body(item, model));
    }
    const handled = state.status !== null && waiting === null && outcome?.kind !== 'success';
    patch(outlet, 'outcome', outcomePanel(outcome, handled, id));
    const answered = waiting === null || outcome?.kind === 'success';
    if (answered) {
      patch(outlet, 'reply', leftover(noteField()));
    } else {
      const model = reviewModel(waiting, { baseBranch: baseBranch() });
      patch(outlet, 'reply', replyBox(phase === 'sending'));
      patch(outlet, 'reply-actions', replyActions(model, phase, noteField()?.value ?? ''));
    }
  };

  const body = (item, model) => {
    if (loadError !== null) return problem('Could not load this item', loadError.message);
    if (detail === null) return loading('what to review');
    const sections = detail.sections ?? [];
    return html`${model.sections.map((key) => {
      switch (key) {
        case 'refined':
          return noteBlock('What the Product Manager understood', sectionText(sections, 'Refined Requirement'), 'Not written.');
        case 'criteria':
          return noteBlock('Acceptance criteria', sectionText(sections, 'Acceptance Criteria'), 'None written.', 'checklist');
        case 'notes': {
          const notes = sectionText(sections, 'Notes');
          return notes === null ? '' : noteBlock('Notes', notes, '');
        }
        case 'plan':
          return html`${noteBlock('The Tech Lead’s plan: feasibility, risks and phases', sectionText(sections, 'Tech Plan'), 'No plan recorded.')}
            ${detail.frontmatter?.slug ? html`<p class="small"><a href="${href({ name: 'feature', slug: detail.frontmatter.slug, tab: 'plan' })}">Read the full plan</a></p>` : ''}`;
        case 'tickets':
          return ticketList(tickets, ticketDetails);
        case 'delivery':
          return deliveryBlock(delivery, deliveryError, sectionText(sections, 'Gate Results'), branches());
        case 'explanation':
          return html`<section class="card"><h2>What happened</h2>
            ${item.pause_detail ? html`<div class="prose">${markdown(item.pause_detail)}</div>` : html`<p class="muted">No explanation was recorded.</p>`}</section>`;
        case 'whatYouCanDo':
          return html`<section class="card what-now"><h2>What you can do</h2><p>${model.whatYouCanDo}</p></section>`;
        case 'logs':
          return logLinks(runs, id);
        default:
          return '';
      }
    })}`;
  };

  const load = async () => {
    try {
      detail = await api(`/api/items/${enc(id)}`, { quiet: true });
      loadError = null;
    } catch (e) {
      if (detail === null || e.status === 404) loadError = e;
    }
    const item = waitingItem(store.get()) ?? lastItem;
    const want = new Set(item === null ? [] : reviewModel(item, { baseBranch: baseBranch() }).sections);
    const slug = detail?.frontmatter?.slug;
    const loads = [];
    if (want.has('tickets') && slug) {
      loads.push(
        api(`/api/features/${enc(slug)}`, { quiet: true }).then(async (feature) => {
          tickets = feature.tickets ?? [];
          await Promise.all(
            tickets
              .filter((t) => !ticketDetails.has(t.id))
              .map((t) => api(`/api/items/${enc(t.id)}`, { quiet: true }).then((d) => ticketDetails.set(t.id, d), () => undefined)),
          );
        }),
      );
    }
    if (want.has('delivery') && slug && deliveryKey !== item.paused_at) {
      loads.push(
        api(`/api/features/${enc(slug)}/delivery`, { quiet: true }).then(
          (d) => {
            delivery = d;
            deliveryError = null;
            deliveryKey = item.paused_at;
          },
          (e) => {
            deliveryError = e.message;
          },
        ),
      );
    }
    if (want.has('logs')) {
      loads.push(api(`/api/items/${enc(id)}/runs`, { quiet: true }).then((r) => (runs = r), () => undefined));
    }
    await Promise.all(loads.map((p) => p.catch(() => undefined)));
    draw();
  };
  const reload = createRefresher(load, () => undefined);

  const onState = (state) => {
    const item = waitingItem(state);
    const key = item === null ? null : `${item.paused_at}|${item.resume_to}|${item.pause_reason}`;
    if (key !== null && key !== pauseKey) {
      pauseKey = key;
      void reload();
    }
    draw();
  };

  const submit = async (action) => {
    if (phase !== 'idle') return;
    const state = store.get();
    const item = waitingItem(state);
    if (item === null) {
      outcome = { kind: 'handled', pausedAt: lastItem?.paused_at };
      draw();
      return;
    }
    const model = reviewModel(item, { baseBranch: baseBranch() });
    const field = noteField();
    const text = field?.value ?? '';
    if (action === 'reject' && text.trim() === '') {
      outcome = { kind: 'error', title: 'Add a note first', message: EMPTY_REASON };
      draw();
      field?.focus();
      return;
    }

    if (action === 'approve' && model.needsMergeConfirm) {
      phase = 'confirming';
      draw();
      const ok = await confirmDialog({
        title: `Merge into ${branches().baseBranch}?`,
        message: mergeConfirmText(branches()),
        confirmLabel: 'Approve and merge',
      });
      if (!ok) {
        phase = 'idle';
        draw();
        return;
      }
    }
    phase = 'sending';
    outcome = null;
    draw();

    const pickUp = { external: state.status?.mode === 'external', pollIntervalSec: state.status?.pollIntervalSec };
    try {
      const body = action === 'approve' ? (text.trim() === '' ? {} : { note: text }) : { reason: text };
      const result = await post(`/api/items/${enc(id)}/${action}`, body);
      await refreshState();
      const after = store.get();
      const still = waitingItem(after);
      if (after.statusError === null && still !== null && still.paused_at === item.paused_at) {
        throw Object.assign(new Error(DID_NOT_STICK), { status: -1, title: 'Your answer did not stick' });
      }
      if (field !== null) field.value = '';
      const said = action === 'approve' ? approveOutcome(result, item, pickUp) : rejectOutcome(item, pickUp);
      outcome = { kind: 'success', pausedAt: item.paused_at, ...said };
      if (result.to === 'done') {
        const where = branches();
        let tag = null;
        try {
          tag = (await api(`/api/features/${enc(detail?.frontmatter?.slug ?? '')}`, { quiet: true })).frontmatter?.tag ?? null;
        } catch {
          // Delivered either way; the tag shows on the feature page.
        }
        outcome = { ...outcome, message: deliveredMessage({ ...where, tag }) };
      }
    } catch (e) {
      outcome =
        classifyFailure(e.status, e.message) === 'handled'
          ? { kind: 'handled', pausedAt: item.paused_at }
          : {
              kind: 'error',
              title: e.title ?? (e.status === 409 ? 'The factory did not do this' : 'That did not work'),
              message: e.message,
            };
    } finally {
      phase = 'idle';
    }
    void refreshState();
    void reload();
    draw();
  };

  const onClick = (event) => {
    const button = event.target.closest('[data-review-action]');
    if (button === null || !outlet.contains(button)) return;
    event.preventDefault();
    void submit(button.dataset.reviewAction);
  };
  const onSubmit = (event) => event.preventDefault();
  const onInput = (event) => {
    if (event.target.matches?.(`[data-keep="${NOTE_KEY}"]`)) draw();
  };
  outlet.addEventListener('click', onClick);
  outlet.addEventListener('submit', onSubmit);
  outlet.addEventListener('input', onInput);

  const unsubscribe = store.subscribe(onState);
  onState(store.get());
  if (pauseKey === null) void reload();

  return {
    update() {
      void reload();
    },
    destroy() {
      alive = false;
      unsubscribe();
      outlet.removeEventListener('click', onClick);
      outlet.removeEventListener('submit', onSubmit);
      outlet.removeEventListener('input', onInput);
    },
  };
}

function header(item, model, waiting) {
  return html`<header class="page-head">
    <p class="crumbs"><a href="#/">Overview</a> <span aria-hidden="true">/</span>
      <a class="mono" href="${href({ name: 'item', id: item.id })}">${item.id}</a> <span aria-hidden="true">/</span> Review</p>
    <p class="review-eyebrow"><span class="pill tone-${model.escalation ? 'failed' : 'waiting'}">${model.reasonLabel}</span>
      <span>${item.title}</span></p>
    <h1>${model.question}</h1>
    ${!model.escalation && item.pause_detail ? html`<p class="muted">${item.pause_detail}</p>` : ''}
    ${waiting && item.paused_at ? html`<p class="muted small">Waiting since <time datetime="${item.paused_at}" title="${clockTime(item.paused_at)}">${relativeTime(item.paused_at)}</time></p>` : ''}
  </header>`;
}

function ticketList(tickets, details) {
  if (tickets === null) return loading('the tickets');
  if (tickets.length === 0) return html`<div class="card"><p class="muted">No tickets were cut.</p></div>`;
  const sorted = [...tickets].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return html`<section class="card"><h2>Tickets <span class="count num">${sorted.length}</span></h2>
    <ol class="review-tickets">${sorted.map((t) => {
      const deps = (t.depends_on ?? []).map(shortTicketId);
      const criteria = sectionText(details.get(t.id)?.sections, 'Acceptance Criteria');
      return html`<li>
        <p class="review-ticket-title"><span class="mono">${shortTicketId(t.id)}</span> <a href="${href({ name: 'item', id: t.id })}">${t.title}</a></p>
        <p class="muted small">${deps.length === 0 ? 'Can start at once' : `Waits for ${deps.join(', ')}`}</p>
        ${criteria === null ? '' : html`<div class="prose checklist">${markdown(criteria)}</div>`}
      </li>`;
    })}</ol></section>`;
}

function deliveryBlock(delivery, error, gateSection, where) {
  const merge = html`<div class="callout tone-waiting-soft"><p>Approving merges <code>${where.featureBranch}</code> into <code>${where.baseBranch}</code> and tags it.</p></div>`;
  if (delivery === null) {
    return html`${merge}${error === null ? loading('the commits') : problem('Could not compare the branches', error)}
      ${gateSection === null ? '' : noteBlock('Check results', gateSection, '')}`;
  }
  const commits = delivery.commits ?? [];
  const files = delivery.diffstat ?? [];
  const gates = delivery.gateResults ?? [];
  return html`${merge}
    <section class="card"><h2>Commits <span class="count num">${commits.length}</span></h2>
      ${commits.length === 0 ? html`<p class="muted">No commits between the branches.</p>` : html`<ul class="commit-list">${commits.map((c) => html`<li><span class="mono">${String(c.sha).slice(0, 8)}</span> ${c.subject}</li>`)}</ul>`}
    </section>
    <section class="card"><h2>Files changed <span class="count num">${files.length}</span></h2>
      ${files.length === 0 ? html`<p class="muted">No file changes.</p>` : html`<ul class="diffstat">${files.map((f) => html`<li><span class="mono">${f.file}</span>
        <span class="small">${f.added === null ? 'binary' : html`<span class="added num">+${f.added}</span> <span class="removed num">−${f.removed}</span>`}</span></li>`)}</ul>`}
    </section>
    ${gateSection === null ? '' : noteBlock('Check results', gateSection, '')}
    ${gates.length === 0 ? '' : html`<section class="card"><h2>Check runs</h2><ul class="gate-list">${gates.map((g) => html`<li class="gate-row"><div class="gate-line">${gateBadge(g.gate, g.status)}
      <a class="small" href="/api/gate-logs/${encodeURIComponent(g.gateLogId)}" target="_blank" rel="noopener">Output</a></div></li>`)}</ul></section>`}`;
}

function logLinks(runs, id) {
  const itemLink = html`<p class="small"><a href="${href({ name: 'item', id })}">Open ${id}</a> for its notes and full history.</p>`;
  if (runs === null) return html`<section class="card"><h2>Logs</h2>${loading('the logs')}</section>`;
  const lastRuns = [...new Map((runs.runs ?? []).map((r) => [r.role, r])).values()];
  const lastGates = [...new Map((runs.gateLogs ?? []).map((g) => [g.gate, g])).values()];
  return html`<section class="card"><h2>Logs</h2>
    ${lastRuns.length === 0 && lastGates.length === 0 ? html`<p class="muted">No agent or check has run for this item yet.</p>` : ''}
    ${lastRuns.length === 0 ? '' : html`<ul class="run-list">${lastRuns.map((r) => html`<li class="run-row"><div class="run-main"><p><strong>${roleLabel(r.role)}</strong> <span class="muted">attempt ${r.attempt}</span></p></div>
      <a class="btn" href="${href({ name: 'run', runId: r.runId })}">Agent log</a></li>`)}</ul>`}
    ${lastGates.length === 0 ? '' : html`<ul class="gate-list">${lastGates.map((g) => html`<li class="gate-row"><div class="gate-line">${gateBadge(g.gate, g.status)}
      <a class="small" href="/api/gate-logs/${encodeURIComponent(g.gateLogId)}" target="_blank" rel="noopener">Check output</a></div></li>`)}</ul>`}
    ${itemLink}</section>`;
}

function outcomePanel(outcome, handled, id) {
  if (outcome?.kind === 'success') {
    return html`<div class="panel ${outcome.tone === 'waiting' ? 'tone-waiting-soft' : 'tone-done-soft'}" role="status">
      <h2>${outcome.title}</h2><p>${outcome.message}</p><p><a href="#/">Back to the overview</a></p></div>`;
  }
  const error =
    outcome?.kind === 'error'
      ? html`<div class="panel panel-failed" role="alert"><h2>${outcome.title}</h2><p class="prewrap">${outcome.message}</p>
          <p class="small">Your note is still in the box. Nothing was lost.</p></div>`
      : '';
  const done =
    handled || outcome?.kind === 'handled'
      ? html`<div class="panel" role="status"><h2>Already handled</h2>
          <p>This item is not waiting for you any more. It was answered somewhere else, for example from the terminal.</p>
          <p><a href="${href({ name: 'item', id })}">Open ${id}</a> · <a href="#/">Back to the overview</a></p></div>`
      : '';
  return html`${error}${done}`;
}

/** Independent of the note, so typing never re-renders (and so never moves) the textarea. */
function replyBox(sending) {
  return html`<form class="card reply" novalidate>
    <h2>Your answer</h2>
    <label for="review-note">Note for the next agent <span class="muted">(optional for approve, required to send back)</span></label>
    <textarea id="review-note" name="note" data-keep="${NOTE_KEY}" rows="5" aria-describedby="review-hint"${sending ? html` readonly` : ''}></textarea>
    <div data-region="reply-actions"></div>
  </form>`;
}

/** Buttons stay disabled while the merge confirm is open; "Sending…" shows only once a request is out. */
function replyActions(model, phase, note) {
  const off = phase !== 'idle' ? html` disabled` : '';
  const sendBack = sendBackControl(model, note);
  return html`<p id="review-hint" class="muted small">${sendBack.hint}</p>
    <div class="reply-actions">
      ${model.canApprove
        ? html`<button type="button" class="btn btn-primary" data-review-action="approve"${off}>${model.approveLabel}</button>`
        : html`<p class="small">${model.noApproveText}</p>`}
      ${sendBack.show
        ? html`<button type="button" class="btn" data-review-action="reject"${phase !== 'idle' || sendBack.disabled ? html` disabled` : ''}>Send back</button>`
        : ''}
      ${phase === 'sending' ? html`<span class="muted small" role="status">Sending…</span>` : ''}
    </div>`;
}

/** Kept while the field still holds text or focus, so a handled item never takes the note with it. */
function leftover(field) {
  if (field === null || (field.value === '' && field !== field.ownerDocument.activeElement)) return html``;
  return html`<div class="card reply">
    <label for="review-note">Your note was not sent</label>
    <textarea id="review-note" name="note" data-keep="${NOTE_KEY}" rows="5" readonly></textarea>
    <p class="muted small">It is kept here so you can copy it.</p>
  </div>`;
}
