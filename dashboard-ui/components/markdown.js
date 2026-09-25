/**
 * A minimal markdown renderer for agent-written vault text. Every character of
 * the source is escaped; the only markup in the output is what this file
 * writes itself: h2–h4, p, ul, ol, li, pre, code, strong, em, a[href^=http|#].
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;

// Placeholders use U+0000, which is stripped from the source first, so a note cannot forge one.
const MARK = '\u0000';
const HELD = new RegExp(`${MARK}([CL])(\\d+)${MARK}`, 'g');

const OUTER_FENCE = /^(`{3,}|~{3,})(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/;

/** The inside of a note wrapped whole in one ```markdown fence, or null if it is not that shape. */
export function unwrapMarkdownFence(text) {
  const m = OUTER_FENCE.exec(String(text ?? '').trim());
  return m === null ? null : m[2];
}

export function renderMarkdown(source) {
  const text = String(source ?? '').replaceAll(MARK, '').replace(/\r\n?/g, '\n');
  return blocks(text.split('\n'));
}

function blocks(lines) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], fence[1])) body.push(lines[i++]);
      i += 1;
      out += `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(4, Math.max(2, heading[1].length));
      out += `<h${level}>${inline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++].trim());
      out += `<pre><code>${escapeHtml(rows.join('\n'))}</code></pre>`;
      continue;
    }

    if (RULE.test(line)) {
      i += 1;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const parsed = list(lines, i);
      out += parsed.html;
      i = parsed.next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !startsBlock(lines[i]))) {
      para.push(lines[i].replace(QUOTE, '').trim());
      i += 1;
    }
    const joined = para.filter((p) => p !== '').join(' ');
    if (joined !== '') out += `<p>${inline(joined)}</p>`;
  }
  return out;
}

function closesFence(line, marker) {
  const t = line.trim();
  return t.length >= marker.length && [...t].every((c) => c === marker[0]);
}

function startsBlock(line) {
  return [FENCE, HEADING, BULLET, ORDERED, TABLE_ROW, RULE].some((re) => re.test(line));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function list(lines, start) {
  const ordered = !BULLET.test(lines[start]);
  const item = ordered ? ORDERED : BULLET;
  const indent = indentOf(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = item.exec(line);
    if (m && m[1].length === indent) {
      items.push({ head: m[2], rest: [] });
      i += 1;
      continue;
    }
    const last = items[items.length - 1];
    if (line.trim() === '') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      const next = lines[j];
      const continues = next !== undefined && (indentOf(next) > indent || (item.test(next) && indentOf(next) === indent));
      if (!continues) break;
      last.rest.push('');
      i += 1;
      continue;
    }
    if (indentOf(line) > indent) {
      last.rest.push(line);
      i += 1;
      continue;
    }
    if (!startsBlock(line)) {
      last.head += ` ${line.trim()}`;
      i += 1;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((it) => `<li>${inline(checkbox(it.head))}${blocks(dedent(it.rest))}</li>`).join('');
  return { html: `<${tag}>${body}</${tag}>`, next: i };
}

function checkbox(text) {
  return text.replace(/^\[ \]\s+/, '☐ ').replace(/^\[[xX]\]\s+/, '☑ ');
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim() !== '').map(indentOf);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(Math.min(cut, indentOf(l))));
}

function inline(text) {
  const codes = [];
  const links = [];
  const hold = (kind, list, value) => {
    list.push(value);
    return `${MARK}${kind}${list.length - 1}${MARK}`;
  };

  const restoreCodes = (value) =>
    value.replace(HELD, (m, kind, n) => (kind === 'C' ? `<code>${escapeHtml(codes[Number(n)])}</code>` : m));

  let s = text.replace(/(`+)(.+?)\1(?!`)/g, (_m, _ticks, code) => hold('C', codes, code));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label, url) => {
    const shown = restoreCodes(emphasis(label));
    if (/^https?:\/\//.test(url)) {
      return hold('L', links, `<a href="${url}" rel="noopener noreferrer" target="_blank">${shown}</a>`);
    }
    if (url.startsWith('#')) return hold('L', links, `<a href="${url}">${shown}</a>`);
    return shown;
  });
  s = restoreCodes(emphasis(s));
  return s.replace(HELD, (_m, _kind, n) => links[Number(n)]);
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
}
