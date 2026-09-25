import { stagePill } from '../components/pill.js';
import { DEMO_REFUSAL, blockedText, draftState } from '../addFeatureModel.js';
import { html, patch, setHtml } from '../render.js';
import { href } from '../routes.js';

const HIGHLIGHT_MS = 4000;

export function mount(outlet, _route, { post, store, refreshState, toast }) {
  let alive = true;
  let busy = false;
  let error = null;

  setHtml(
    outlet,
    html`<div class="page add-page">
      <header class="page-head">
        <p class="crumbs"><a href="#/">Overview</a> <span aria-hidden="true">/</span> Add a feature</p>
        <h1>Add a feature</h1>
      </header>
      <div data-region="blocked"></div>
      <div data-region="error" aria-live="polite"></div>
      <form class="card add-form" novalidate data-region="form"></form>
    </div>`,
  );

  const field = (key) => outlet.querySelector(`[data-keep="${key}"]`);
  const draft = () => ({
    name: field('feature-name')?.value ?? '',
    priority: field('feature-priority')?.value ?? 'medium',
    requirement: field('feature-requirement')?.value ?? '',
  });

  const draw = () => {
    if (!alive) return;
    const status = store.get().status;
    const features = status?.features ?? [];
    const d = draft();
    const st = draftState(d, features, { demo: status?.demo === true });
    patch(
      outlet,
      'blocked',
      st.demoBlocked
        ? html`<div class="panel tone-waiting-soft" role="status"><p>${DEMO_REFUSAL}</p></div>`
        : st.blocker === null
          ? html``
          : blockedPanel(st.blocker),
    );
    patch(
      outlet,
      'error',
      error === null
        ? html``
        : html`<div class="panel panel-failed" role="alert"><h2>The feature was not added</h2><p class="prewrap">${error}</p>
            <p class="small">Your text is still in the form.</p></div>`,
    );
    const locked = busy || status === null || st.demoBlocked || st.blocker !== null;
    patch(outlet, 'form', form(locked));
    patch(outlet, 'preview', preview(st, d));
    patch(
      outlet,
      'actions',
      html`<button type="submit" class="btn btn-primary"${!st.canSubmit || locked ? html` disabled` : ''}>Add feature</button>
        ${busy ? html`<span class="muted small" role="status">Adding…</span>` : ''}`,
    );
  };

  const submit = async () => {
    if (busy) return;
    const status = store.get().status;
    const d = draft();
    if (!draftState(d, status?.features ?? [], { demo: status?.demo === true }).canSubmit) return;
    busy = true;
    error = null;
    draw();
    try {
      const added = await post('/api/features', { name: d.name, priority: d.priority, requirement: d.requirement });
      toast(addedMessage(added.id, status), 'done');
      store.set({ justAdded: added.slug });
      setTimeout(() => {
        if (store.get().justAdded === added.slug) store.set({ justAdded: null });
      }, HIGHLIGHT_MS);
      location.hash = href({ name: 'feature', slug: added.slug, tab: 'overview' });
    } catch (e) {
      error = e.message;
      busy = false;
      void refreshState();
      draw();
    }
  };

  const onInput = () => draw();
  const onSubmit = (event) => {
    event.preventDefault();
    void submit();
  };
  outlet.addEventListener('input', onInput);
  outlet.addEventListener('change', onInput);
  outlet.addEventListener('submit', onSubmit);
  const unsubscribe = store.subscribe(draw);
  draw();

  return {
    destroy() {
      alive = false;
      unsubscribe();
      outlet.removeEventListener('input', onInput);
      outlet.removeEventListener('change', onInput);
      outlet.removeEventListener('submit', onSubmit);
    },
  };
}

function addedMessage(id, status) {
  if (status?.mode === 'hosted') return `Added ${id}. The Product Manager picks it up within seconds.`;
  if (status?.mode === 'external') return `Added ${id}. The factory will pick this up within ${status.pollIntervalSec} s.`;
  return `Added ${id}. Start the factory and the Product Manager picks it up.`;
}

function blockedPanel(feature) {
  return html`<div class="panel tone-waiting-soft" role="status">
    <p>${blockedText(feature)}</p>
    <p><a href="${href({ name: 'feature', slug: feature.slug, tab: 'overview' })}">Open ${feature.title}</a> ${stagePill(feature.status)}</p>
  </div>`;
}

function preview(st, d) {
  if (d.name.trim() === '') return html`<span class="muted">Type a name to see its ID.</span>`;
  if (st.preview === null) return html`<span class="field-problem">This name has no letters or digits the factory can use.</span>`;
  if (st.duplicate !== null) {
    return html`<span class="field-problem">${st.duplicate.title} already has this name (<a class="mono" href="${href({ name: 'feature', slug: st.duplicate.slug, tab: 'overview' })}">${st.duplicate.id}</a>). Pick another.</span>`;
  }
  return html`ID: <span class="mono">${st.preview.id}</span>`;
}

/** Depends only on `locked`, so typing never re-renders (and so never moves) the fields. */
function form(locked) {
  const off = locked ? html` disabled` : '';
  return html`
    <div class="field">
      <label for="feature-name">Name</label>
      <input id="feature-name" name="name" type="text" data-keep="feature-name" autocomplete="off" maxlength="120"
        placeholder="Expression calculator" aria-describedby="feature-id"${off}>
      <p id="feature-id" class="small" aria-live="polite" data-region="preview"></p>
    </div>
    <div class="field">
      <label for="feature-priority">Priority</label>
      <select id="feature-priority" name="priority" data-keep="feature-priority"${off}>
        <option value="high">High</option>
        <option value="medium" selected>Medium</option>
        <option value="low">Low</option>
      </select>
    </div>
    <div class="field">
      <label for="feature-requirement">Requirement</label>
      <textarea id="feature-requirement" name="requirement" data-keep="feature-requirement" rows="10"
        aria-describedby="feature-hint"${off}></textarea>
      <p id="feature-hint" class="muted small">Give concrete examples of input and expected output — they become the acceptance criteria.</p>
    </div>
    <div class="form-actions" data-region="actions"></div>`;
}
