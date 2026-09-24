/**
 * The only place the page turns strings into DOM. Markup is built with the
 * escaping `html` template (or `markdown()`), which yields SafeHtml; the DOM
 * helpers below accept nothing else.
 */
import { escapeHtml, renderMarkdown } from './components/markdown.js';

const MINT = Symbol('SafeHtml');

export class SafeHtml {
  constructor(value, mint) {
    if (mint !== MINT) throw new TypeError('SafeHtml is created only by html`` or markdown()');
    this.html = value;
    Object.freeze(this);
  }

  toString() {
    return this.html;
  }
}

function fragment(value) {
  if (value instanceof SafeHtml) return value.html;
  if (Array.isArray(value)) return value.map(fragment).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += fragment(value) + strings[i + 1];
  });
  return new SafeHtml(out, MINT);
}

export function markdown(source) {
  return new SafeHtml(renderMarkdown(source), MINT);
}

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isDirty(el) {
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'SELECT') return [...(el.options ?? [])].some((o) => o.selected !== o.defaultSelected);
  if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked !== el.defaultChecked;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return el.value !== el.defaultValue;
  return false;
}

/** False only for a `data-keep` form field that is focused or holds unsaved input. */
export function shouldReplace(el, active) {
  if (!FORM_TAGS.has(String(el.tagName).toUpperCase())) return true;
  if (el.dataset?.keep === undefined) return true;
  return !(el === active || isDirty(el));
}

// ---- DOM part (not unit-tested; see plan A4) ----

const rendered = new WeakMap();

function requireSafe(content) {
  if (!(content instanceof SafeHtml)) throw new TypeError('the page only renders SafeHtml');
  return content.html;
}

const FIELDS = 'input, textarea, select';
const LIVE_STATE_ATTRIBUTES = new Set(['value', 'checked', 'selected']);

function protectedFields(root, active) {
  return [...root.querySelectorAll(FIELDS)].filter((f) => !shouldReplace(f, active));
}

function fieldKey(field) {
  const keep = field.dataset?.keep;
  if (keep) return `keep:${keep}`;
  const name = field.getAttribute('name');
  return name ? `name:${name}` : null;
}

function syncAttributes(target, source) {
  for (const { name } of [...target.attributes]) {
    if (!LIVE_STATE_ATTRIBUTES.has(name) && !source.hasAttribute(name)) target.removeAttribute(name);
  }
  for (const { name, value } of [...source.attributes]) {
    if (!LIVE_STATE_ATTRIBUTES.has(name) && target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

/**
 * Replaces `target`'s children with `fragment`'s, but each focused or dirty
 * `data-keep` field is swapped into the new tree in place of its counterpart
 * (same tag and `data-keep`, else `name`). False, touching nothing, if one has no counterpart.
 */
export function applyKeeping(target, fragment, active) {
  const kept = protectedFields(target, active);
  const fresh = [...fragment.querySelectorAll(FIELDS)];
  const pairs = [];
  for (const live of kept) {
    const key = fieldKey(live);
    const match = fresh.find(
      (f) => key !== null && f.tagName === live.tagName && fieldKey(f) === key && !pairs.some(([, used]) => used === f),
    );
    if (match === undefined) return false;
    pairs.push([live, match]);
  }

  const focused = kept.includes(active) ? active : null;
  const selection = focused === null ? null : { start: focused.selectionStart, end: focused.selectionEnd, top: focused.scrollTop };
  for (const [live, match] of pairs) {
    syncAttributes(live, match);
    match.replaceWith(live);
  }
  target.replaceChildren(...fragment.childNodes);
  if (focused !== null && focused.ownerDocument.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    try {
      if (selection.start !== null && selection.start !== undefined) focused.setSelectionRange(selection.start, selection.end);
    } catch {
      // not a text field
    }
    if (typeof selection.top === 'number') focused.scrollTop = selection.top;
  }
  return true;
}

/** Replaces `el`'s content, keeping any focused or dirty `data-keep` field (see applyKeeping). */
export function setHtml(el, content) {
  const markup = requireSafe(content);
  if (rendered.get(el) === markup) return;
  const active = el.ownerDocument.activeElement;
  if (protectedFields(el, active).length === 0) {
    el.innerHTML = markup;
    rendered.set(el, markup);
    return;
  }
  const next = el.ownerDocument.createElement('template');
  next.innerHTML = markup;
  if (applyKeeping(el, next.content, active)) rendered.set(el, markup);
  else rendered.delete(el);
}

/** Renders one named region (`data-region="name"`) inside `root`; returns it, or null. */
export function patch(root, name, content) {
  const region = root.querySelector(`[data-region="${CSS.escape(name)}"]`);
  if (region !== null) setHtml(region, content);
  return region;
}

function toFragment(el, content) {
  const t = el.ownerDocument.createElement('template');
  t.innerHTML = requireSafe(content);
  return t.content;
}

export function append(el, content) {
  el.append(toFragment(el, content));
  rendered.delete(el);
}

export function prepend(el, content) {
  el.prepend(toFragment(el, content));
  rendered.delete(el);
}
