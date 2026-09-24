/**
 * The form-safe rendering rule (plan Phase 7, devils-advocate mitigation 4)
 * and the escaping `html` template every view builds its markup with.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { SafeHtml, applyKeeping, html, isDirty, markdown, shouldReplace } from '../../../dashboard-ui/render.js';
import type { FieldLike } from '../../../dashboard-ui/render.js';

const textarea = (over: Partial<FieldLike> = {}): FieldLike => ({
  tagName: 'TEXTAREA',
  dataset: { keep: 'reply' },
  value: '',
  defaultValue: '',
  ...over,
});

describe('shouldReplace', () => {
  it('a focused data-keep field is kept', () => {
    const field = textarea();
    expect(shouldReplace(field, field)).toBe(false);
  });

  it('a dirty data-keep field is kept even when it is not focused', () => {
    expect(shouldReplace(textarea({ value: 'half a sentence' }), null)).toBe(false);
  });

  it('an unfocused, clean data-keep field is replaced', () => {
    expect(shouldReplace(textarea(), null)).toBe(true);
    expect(shouldReplace(textarea(), textarea())).toBe(true);
  });

  it('a non-form region is replaced, even when it holds focus', () => {
    const region: FieldLike = { tagName: 'SECTION', dataset: {} };
    expect(shouldReplace(region, region)).toBe(true);
  });

  it('a form field without data-keep is not protected', () => {
    const field: FieldLike = { tagName: 'INPUT', type: 'text', dataset: {}, value: 'typed', defaultValue: '' };
    expect(shouldReplace(field, field)).toBe(true);
  });

  it.each(['INPUT', 'SELECT', 'TEXTAREA'])('%s with data-keep and focus is kept', (tagName) => {
    const field: FieldLike = { tagName, dataset: { keep: '' }, value: '', defaultValue: '', options: [] };
    expect(shouldReplace(field, field)).toBe(false);
  });
});

describe('isDirty', () => {
  it('a text field is dirty when its value differs from its default', () => {
    expect(isDirty({ tagName: 'INPUT', type: 'text', dataset: {}, value: 'a', defaultValue: '' })).toBe(true);
    expect(isDirty({ tagName: 'INPUT', type: 'text', dataset: {}, value: 'a', defaultValue: 'a' })).toBe(false);
  });

  it('a checkbox is dirty when checked differs from its default', () => {
    expect(isDirty({ tagName: 'INPUT', type: 'checkbox', dataset: {}, checked: true, defaultChecked: false })).toBe(true);
    expect(isDirty({ tagName: 'INPUT', type: 'radio', dataset: {}, checked: false, defaultChecked: false })).toBe(false);
  });

  it('a select is dirty when any option selection differs from its default', () => {
    const options = [
      { selected: false, defaultSelected: true },
      { selected: true, defaultSelected: false },
    ];
    expect(isDirty({ tagName: 'SELECT', dataset: {}, options })).toBe(true);
    expect(isDirty({ tagName: 'SELECT', dataset: {}, options: [{ selected: true, defaultSelected: true }] })).toBe(false);
  });

  it('a non-form element is never dirty', () => {
    expect(isDirty({ tagName: 'DIV', dataset: {} })).toBe(false);
  });
});

describe('html template', () => {
  it('escapes every interpolated value', () => {
    const title = '<img src=x onerror=alert(1)>';
    expect(html`<h1>${title}</h1>`.html).toBe('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
    expect(html`<a title="${'" onmouseover="x()'}">`.html).toBe('<a title="&quot; onmouseover=&quot;x()">');
  });

  it('nests html fragments without escaping them twice', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(html`<p>${inner}</p>`.html).toBe('<p><b>&lt;i&gt;</b></p>');
  });

  it('joins arrays, and renders null, undefined and false as nothing', () => {
    expect(html`<ul>${['<a>', html`<li>b</li>`]}</ul>`.html).toBe('<ul>&lt;a&gt;<li>b</li></ul>');
    expect(html`${null}${undefined}${false}${0}`.html).toBe('0');
  });

  it('a plain object is not trusted just because it has an html property', () => {
    expect(html`${{ html: '<script>' }}`.html).toBe('[object Object]');
  });

  it('markdown() goes through the escaping renderer', () => {
    const out = markdown('**hi** <script>x()</script>');
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.html).toBe('<p><strong>hi</strong> &lt;script&gt;x()&lt;/script&gt;</p>');
  });
});

// A minimal fake DOM: just what applyKeeping touches. Moving a focused node blurs it, as browsers do.
class FakeDoc {
  activeElement: FakeEl | null = null;
}

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeEl | FakeFragment | null = null;
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

type Kid = FakeEl | FakeText;

class FakeParent {
  childNodes: Kid[] = [];
  constructor(readonly doc: FakeDoc) {}
  detach(kid: Kid): void {
    const i = this.childNodes.indexOf(kid);
    if (i >= 0) this.childNodes.splice(i, 1);
    kid.parentNode = null;
    if (kid instanceof FakeEl) kid.blurTree();
  }
  adopt(kid: Kid): Kid {
    kid.parentNode?.detach(kid);
    kid.parentNode = this as unknown as FakeEl;
    return kid;
  }
  replaceChildren(...kids: Kid[]): void {
    for (const k of [...this.childNodes]) this.detach(k);
    for (const k of kids) this.childNodes.push(this.adopt(k));
  }
  querySelectorAll(sel: string): FakeEl[] {
    const tags = sel.split(',').map((t) => t.trim().toUpperCase());
    const out: FakeEl[] = [];
    const walk = (p: FakeParent): void => {
      for (const c of p.childNodes) {
        if (c instanceof FakeEl) {
          if (tags.includes(c.tagName)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

class FakeFragment extends FakeParent {}

class FakeEl extends FakeParent {
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: FakeEl | FakeFragment | null = null;
  attrs = new Map<string, string>();
  value = '';
  defaultValue = '';
  selectionStart = 0;
  selectionEnd = 0;
  constructor(doc: FakeDoc, tag: string, attrs: Record<string, string> = {}) {
    super(doc);
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  get ownerDocument(): FakeDoc {
    return this.doc;
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5)] = v;
    return out;
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
  replaceWith(other: Kid): void {
    const parent = this.parentNode;
    if (parent === null) throw new Error('no parent');
    parent.adopt(other);
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, other);
    this.parentNode = null;
    this.blurTree();
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  blurTree(): void {
    const active = this.doc.activeElement;
    if (active !== null && (active === this || this.contains(active))) this.doc.activeElement = null;
  }
  contains(node: FakeEl): boolean {
    return this.querySelectorAll('*').includes(node) || this.childNodes.some((c) => c === node);
  }
  override querySelectorAll(sel: string): FakeEl[] {
    if (sel !== '*') return super.querySelectorAll(sel);
    const out: FakeEl[] = [];
    const walk = (p: FakeParent): void => {
      for (const c of p.childNodes) {
        if (c instanceof FakeEl) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  override toString(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.childNodes.map(String).join('')}</${this.tagName.toLowerCase()}>`;
  }
}

describe('applyKeeping (the form-safe swap, over a fake DOM)', () => {
  let doc: FakeDoc;
  const el = (tag: string, attrs: Record<string, string> = {}, ...kids: (Kid | string)[]): FakeEl => {
    const e = new FakeEl(doc, tag, attrs);
    e.replaceChildren(...kids.map((k) => (typeof k === 'string' ? new FakeText(k) : k)));
    return e;
  };
  const fragment = (...kids: Kid[]): FakeFragment => {
    const f = new FakeFragment(doc);
    f.replaceChildren(...kids);
    return f;
  };
  const reply = (attrs: Record<string, string> = {}): FakeEl => el('textarea', { 'data-keep': 'reply', ...attrs });

  beforeEach(() => {
    doc = new FakeDoc();
  });

  function typedInto(field: FakeEl, text: string): FakeEl {
    field.value = text;
    field.focus();
    field.setSelectionRange(2, 4);
    return field;
  }

  it('keeps the live field when a sibling is inserted above it', () => {
    const live = reply();
    const region = el('div', {}, el('p', {}, 'a'), live, el('button', {}, 'send'));
    typedInto(live, 'half typed');
    const ok = applyKeeping(region, fragment(el('p', {}, 'a'), el('p', {}, 'INSERTED'), reply(), el('button', {}, 'send')), doc.activeElement);
    expect(ok).toBe(true);
    expect(String(region)).toBe('<div><p>a</p><p>INSERTED</p><textarea data-keep="reply"></textarea><button>send</button></div>');
    expect(region.querySelectorAll('textarea')).toEqual([live]);
    expect(live.value).toBe('half typed');
    expect(doc.activeElement).toBe(live);
    expect([live.selectionStart, live.selectionEnd]).toEqual([2, 4]);
  });

  it('keeps the live field when a sibling above it is removed', () => {
    const live = reply();
    const region = el('div', {}, el('p', {}, 'a'), el('p', {}, 'b'), live, el('button', {}, 'send'));
    live.value = 'dirty';
    expect(applyKeeping(region, fragment(el('p', {}, 'a'), reply(), el('button', {}, 'send')), null)).toBe(true);
    expect(String(region)).toBe('<div><p>a</p><textarea data-keep="reply"></textarea><button>send</button></div>');
    expect(region.querySelectorAll('textarea')).toEqual([live]);
    expect(live.value).toBe('dirty');
  });

  it('finds the field inside a wrapper when a sibling is inserted above the wrapper', () => {
    const live = reply();
    const region = el('form', {}, el('p', {}, 'a'), el('label', {}, 'Note', live));
    typedInto(live, 'x');
    const next = fragment(el('p', {}, 'a'), el('p', {}, 'INSERTED'), el('label', {}, 'Note', reply()));
    expect(applyKeeping(region, next, doc.activeElement)).toBe(true);
    expect(String(region)).toBe('<form><p>a</p><p>INSERTED</p><label>Note<textarea data-keep="reply"></textarea></label></form>');
    expect(region.querySelectorAll('textarea')).toEqual([live]);
    expect(doc.activeElement).toBe(live);
  });

  it('syncs attributes onto the kept field while keeping its value and focus', () => {
    const live = reply({ placeholder: 'old' });
    const region = el('div', {}, live);
    typedInto(live, 'mine');
    expect(applyKeeping(region, fragment(reply({ disabled: '', placeholder: 'new' })), doc.activeElement)).toBe(true);
    expect(region.childNodes[0]).toBe(live);
    expect(live.hasAttribute('disabled')).toBe(true);
    expect(live.getAttribute('placeholder')).toBe('new');
    expect(live.value).toBe('mine');
    expect(doc.activeElement).toBe(live);
  });

  it('matches by name when data-keep is empty', () => {
    const live = el('input', { 'data-keep': '', name: 'slug' });
    const region = el('div', {}, live);
    live.value = 'abc';
    expect(applyKeeping(region, fragment(el('p', {}, 'hint'), el('input', { 'data-keep': '', name: 'slug' })), null)).toBe(true);
    expect(region.childNodes[1]).toBe(live);
  });

  it('refuses, leaving the region untouched, when the new markup has no counterpart for a dirty field', () => {
    const live = reply();
    const region = el('div', {}, el('p', {}, 'a'), live);
    live.value = 'unsaved';
    const before = String(region);
    expect(applyKeeping(region, fragment(el('p', {}, 'gone')), null)).toBe(false);
    expect(String(region)).toBe(before);
    expect(region.childNodes[1]).toBe(live);
  });

  it('replaces a clean, unfocused field with the new one', () => {
    const old = reply();
    const region = el('div', {}, old);
    const fresh = reply({ disabled: '' });
    expect(applyKeeping(region, fragment(fresh), null)).toBe(true);
    expect(region.childNodes[0]).toBe(fresh);
  });
});
