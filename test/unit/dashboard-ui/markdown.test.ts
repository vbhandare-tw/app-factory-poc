/**
 * The escaping markdown renderer (tech spec §3, plan Phase 7). Vault notes are
 * agent-written, so the output may only ever contain the allowlisted elements.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown, unwrapMarkdownFence } from '../../../dashboard-ui/components/markdown.js';
import { splitSections } from '../../../src/dashboard/sections.js';

const ALLOWED_TAGS = new Set(['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'a']);

/** Every tag in `out` is allowlisted, and only `<a>` carries attributes: a safe `href` and nothing else. */
function expectOnlyAllowlisted(out: string): void {
  for (const match of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const [whole, name = '', attrs = ''] = match;
    expect(ALLOWED_TAGS.has(name), `tag <${name}> in ${whole}`).toBe(true);
    if (whole.startsWith('</')) {
      expect(attrs, whole).toBe('');
      continue;
    }
    if (name !== 'a') {
      expect(attrs, whole).toBe('');
      continue;
    }
    expect(attrs, whole).toMatch(
      /^ href="(https?:\/\/[^"<>\s]*|#[^"<>\s]*)"( rel="noopener noreferrer" target="_blank")?$/,
    );
  }
  expect(out).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
}

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'dashboard',
  'feature.md',
);

function realBody(): string {
  const raw = readFileSync(FIXTURE, 'utf8');
  const end = raw.indexOf('\n---\n', 4);
  return raw.slice(end + '\n---\n'.length);
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown: hostile input is escaped or dropped', () => {
  it.each([
    ['a script tag', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['an img with onerror', '<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['raw block HTML with a handler', '<div onclick="steal()">hi</div>', '&lt;div onclick=&quot;steal()&quot;&gt;'],
    ['an svg onload', '<svg/onload=alert(1)>', '&lt;svg/onload=alert(1)&gt;'],
    ['an iframe', '<iframe src="https://evil.example"></iframe>', '&lt;iframe'],
    ['HTML inside a list item', '- <b onmouseover="x()">bold</b>', '&lt;b onmouseover=&quot;x()&quot;&gt;'],
    ['HTML inside a heading', '## <script>x()</script>', '&lt;script&gt;x()&lt;/script&gt;'],
  ])('%s', (_label, source, expected) => {
    const out = renderMarkdown(source);
    expect(out).toContain(expected);
    expectOnlyAllowlisted(out);
  });

  it.each([
    ['javascript:', '[click](javascript:alert(1))'],
    ['mixed-case javascript:', '[click](JaVaScRiPt:alert(1))'],
    ['an entity-encoded javascript:', '[click](&#106;avascript:alert(1))'],
    ['data:', '[click](data:text/html,<script>alert(1)</script>)'],
    ['vbscript:', '[click](vbscript:msgbox(1))'],
    ['a protocol-relative URL', '[click](//evil.example/x)'],
    ['a relative path', '[click](../../etc/passwd)'],
  ])('a %s link is dropped to its text', (_label, source) => {
    const out = renderMarkdown(source);
    expect(out).not.toContain('<a');
    expect(out).toContain('click');
    expectOnlyAllowlisted(out);
  });

  it('a quote in a link URL cannot break out of the href attribute', () => {
    const out = renderMarkdown('[x](https://ok.example/"onmouseover="alert(1))');
    expectOnlyAllowlisted(out);
    expect(out).not.toMatch(/"\s*onmouseover=/);
  });

  it('link text is escaped too', () => {
    const out = renderMarkdown('[<img src=x onerror=y()>](https://ok.example)');
    expect(out).toContain('&lt;img src=x onerror=y()&gt;');
    expectOnlyAllowlisted(out);
  });

  it('the internal placeholder character in the source cannot smuggle markup', () => {
    const out = renderMarkdown('\u0000C0\u0000 and `<b>x</b>` and \u0000L0\u0000');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('\u0000');
    expectOnlyAllowlisted(out);
  });
});

describe('renderMarkdown: the supported subset renders', () => {
  it('headings map onto h2–h4 only', () => {
    expect(renderMarkdown('# One')).toBe('<h2>One</h2>');
    expect(renderMarkdown('## Two')).toBe('<h2>Two</h2>');
    expect(renderMarkdown('### Three')).toBe('<h3>Three</h3>');
    expect(renderMarkdown('#### Four')).toBe('<h4>Four</h4>');
    expect(renderMarkdown('###### Six')).toBe('<h4>Six</h4>');
  });

  it('paragraphs join their lines and split on blank lines', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one two</p><p>three</p>');
  });

  it('bullet and numbered lists', () => {
    expect(renderMarkdown('- a\n- b\n* c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('an indented list nests inside its item', () => {
    expect(renderMarkdown('- a\n  - a1\n  - a2\n- b')).toBe(
      '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>',
    );
  });

  it('fenced code keeps its content verbatim', () => {
    expect(renderMarkdown('```ts\nconst x = 1;\n  indented\n```')).toBe(
      '<pre><code>const x = 1;\n  indented</code></pre>',
    );
  });

  it('inline code, bold, italic and an http link', () => {
    expect(renderMarkdown('Run `npm test`, **now**, *please*: [docs](https://example.com/a?b=1&c=2)')).toBe(
      '<p>Run <code>npm test</code>, <strong>now</strong>, <em>please</em>: ' +
        '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">docs</a></p>',
    );
  });

  it('inline code inside a link label is restored, not left as a placeholder', () => {
    expect(renderMarkdown('[`code`](https://a.example)')).toBe(
      '<p><a href="https://a.example" rel="noopener noreferrer" target="_blank"><code>code</code></a></p>',
    );
  });

  it('bold and inline code together inside a link label', () => {
    const out = renderMarkdown('[**b** `c`](https://a.example)');
    expect(out).toBe(
      '<p><a href="https://a.example" rel="noopener noreferrer" target="_blank"><strong>b</strong> <code>c</code></a></p>',
    );
    expect(out).not.toContain('\u0000');
  });

  it('inline code in a dropped link keeps its code, escaped', () => {
    const out = renderMarkdown('[`<b>`](javascript:x)');
    expect(out).toBe('<p><code>&lt;b&gt;</code></p>');
  });

  it('an in-page # link stays in the tab', () => {
    expect(renderMarkdown('[T001](#/i/T001)')).toBe('<p><a href="#/i/T001">T001</a></p>');
  });

  it('a code fence containing <b> shows literal text', () => {
    const out = renderMarkdown('```\n<b>bold?</b>\n```');
    expect(out).toBe('<pre><code>&lt;b&gt;bold?&lt;/b&gt;</code></pre>');
  });

  it('inline code is not re-parsed for emphasis or links', () => {
    expect(renderMarkdown('`**x** [a](https://e.com)`')).toBe('<p><code>**x** [a](https://e.com)</code></p>');
  });

  it('snake_case words are not italicised', () => {
    expect(renderMarkdown('pause_reason and resume_to')).toBe('<p>pause_reason and resume_to</p>');
  });

  it('an unterminated fence renders the rest as code without throwing', () => {
    expect(renderMarkdown('```\nopen <i>')).toBe('<pre><code>open &lt;i&gt;</code></pre>');
  });

  it('a table is shown as preformatted text, since table tags are not allowed', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| <x> | 2 |');
    expect(out).toBe('<pre><code>| a | b |\n|---|---|\n| &lt;x&gt; | 2 |</code></pre>');
  });

  it('empty and whitespace-only input renders nothing', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('  \n\n ')).toBe('');
  });
});

describe('renderMarkdown on the real feature note', () => {
  const sections = splitSections(realBody());

  it.each(sections.map((s) => [s.heading || '(preamble)', s.markdown] as const))(
    '%s renders without throwing, inside the allowlist',
    (_heading, markdown) => {
      const out = renderMarkdown(markdown);
      expect(out.length).toBeGreaterThan(0);
      expectOnlyAllowlisted(out);
    },
  );
});

describe('unwrapMarkdownFence', () => {
  it('unwraps one outer ```markdown fence, keeping inner fences', () => {
    expect(unwrapMarkdownFence('```markdown\n# Title\n\n```ts\nx\n```\n\nText\n```')).toBe(
      '# Title\n\n```ts\nx\n```\n\nText',
    );
  });

  it.each(['```md\nhi\n```', '~~~markdown\nhi\n~~~', '````markdown\nhi\n````', '```\nhi\n```'])(
    'accepts %j',
    (text) => {
      expect(unwrapMarkdownFence(text)).toBe('hi');
    },
  );

  it.each([
    ['plain markdown', '# Title\n\nText'],
    ['a code fence of another language', '```ts\nconst x = 1;\n```'],
    ['text after the closing fence', '```markdown\nhi\n```\nmore'],
    ['an unterminated fence', '```markdown\nhi'],
  ])('returns null for %s', (_label, text) => {
    expect(unwrapMarkdownFence(text)).toBeNull();
  });

  it('the real raw requirement unwraps and renders its heading and list, still inside the allowlist', () => {
    const raw = splitSections(realBody()).find((s) => s.heading === 'Raw Requirement')?.markdown ?? '';
    const inner = unwrapMarkdownFence(raw);
    expect(inner).not.toBeNull();
    const out = renderMarkdown(inner);
    expect(out).toContain('<h2>');
    expect(out).not.toMatch(/^<pre>/);
    expectOnlyAllowlisted(out);
  });
});
