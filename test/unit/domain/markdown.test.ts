import { describe, expect, it } from 'vitest';

import {
  findHeading,
  removeSections,
  scanMarkdown,
  sectionEnd,
  sectionText,
} from '../../../src/domain/markdown.js';

const scanOf = (body: string): { lines: string[]; scan: ReturnType<typeof scanMarkdown> } => {
  const lines = body.split('\n');
  return { lines, scan: scanMarkdown(lines) };
};

describe('scanMarkdown — headings', () => {
  it('finds every plain ATX heading', () => {
    const { scan } = scanOf(['# One', '', 'text', '## Two', '### Three', ''].join('\n'));
    expect(scan.headings).toEqual([0, 3, 4]);
  });

  it('requires whitespace after the hashes, matching the pre-refactor behaviour', () => {
    const { scan } = scanOf(['#NotAHeading', '####### Seven hashes', '## Real', ''].join('\n'));
    expect(scan.headings).toEqual([2]);
  });

  it('reports no headings for a body that has none', () => {
    const { scan } = scanOf('just words\nand more words\n');
    expect(scan.headings).toEqual([]);
  });
});

describe('scanMarkdown — fenced code blocks', () => {
  it('does not treat a ## line inside a backtick fence as a heading', () => {
    const { scan } = scanOf(
      ['## Real', '', '```md', '## Not a heading', '```', '', '## Also real', ''].join('\n'),
    );
    expect(scan.headings).toEqual([0, 6]);
  });

  it('does not treat a ## line inside a tilde fence as a heading', () => {
    const { scan } = scanOf(['~~~', '## Inside', '~~~', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([3]);
  });

  it('marks every line of a fenced block, delimiters included', () => {
    const { scan } = scanOf(['before', '```', 'code', '```', 'after', ''].join('\n'));
    expect(scan.fenced).toEqual([false, true, true, true, false, false]);
  });

  it('a tilde fence is not closed by a backtick fence', () => {
    const { scan } = scanOf(['~~~', '```', '## Still inside', '~~~', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([4]);
  });

  it('a longer fence is not closed by a shorter one', () => {
    const { scan } = scanOf(
      ['````', '```', '## Still inside', '````', '## Outside', ''].join('\n'),
    );
    expect(scan.headings).toEqual([4]);
  });

  it('a closing fence may be longer than the opening one', () => {
    const { scan } = scanOf(['```', 'code', '`````', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([3]);
  });

  it('a backtick line with a backtick in its info string is not a fence', () => {
    const { scan } = scanOf(['``` a `b` c', '## Heading', ''].join('\n'));
    expect(scan.headings).toEqual([1]);
  });

  it('a fence with a language info string still opens a block', () => {
    const { scan } = scanOf(['```typescript', '## Inside', '```', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([3]);
  });

  it('a line with trailing text after the closing marker does not close the fence', () => {
    const { scan } = scanOf(['```', '``` not a close', '## Inside', '```', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([4]);
  });

  it('an unclosed fence swallows the rest of the body', () => {
    const { scan } = scanOf(['## Real', '```', '## Never a heading', '## Nor this', ''].join('\n'));
    expect(scan.headings).toEqual([0]);
  });

  it('tolerates up to three spaces of indent on a fence', () => {
    const { scan } = scanOf(['   ```', '## Inside', '   ```', '## Outside', ''].join('\n'));
    expect(scan.headings).toEqual([3]);
  });
});

describe('findHeading', () => {
  it('finds a heading by exact trimmed text', () => {
    const { lines, scan } = scanOf(['## Raw Requirement', '', '## History', ''].join('\n'));
    expect(findHeading(lines, scan, '## History')).toBe(2);
  });

  it('returns -1 when the heading is absent', () => {
    const { lines, scan } = scanOf('## Raw Requirement\n\nx\n');
    expect(findHeading(lines, scan, '## History')).toBe(-1);
  });

  it('ignores a matching heading that sits inside a code fence', () => {
    const { lines, scan } = scanOf(
      ['## Raw Requirement', '', '```md', '## History', '- fake entry', '```', ''].join('\n'),
    );
    expect(findHeading(lines, scan, '## History')).toBe(-1);
  });

  it('finds the real heading when a decoy sits in a fence above it', () => {
    const { lines, scan } = scanOf(
      [
        '## Raw Requirement',
        '',
        '```md',
        '## History',
        '```',
        '',
        '## History',
        '',
        '- real entry',
        '',
      ].join('\n'),
    );
    expect(findHeading(lines, scan, '## History')).toBe(6);
  });
});

describe('sectionEnd', () => {
  it('ends a section at the next real heading', () => {
    const { lines, scan } = scanOf(['## A', '', 'x', '', '## B', '', 'y', ''].join('\n'));
    expect(sectionEnd(scan, 0, lines.length)).toBe(4);
  });

  it('runs to the end of the body when nothing follows', () => {
    const { lines, scan } = scanOf(['## A', '', 'x', ''].join('\n'));
    expect(sectionEnd(scan, 0, lines.length)).toBe(lines.length);
  });

  it('does not stop at a ## line inside a fence within the section', () => {
    const { lines, scan } = scanOf(
      ['## A', '', '```md', '## Fake', '```', '', 'still section A', '', '## B', ''].join('\n'),
    );
    expect(sectionEnd(scan, 0, lines.length)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Added in Phase 6. `sectionText` is how a context recipe reads a note section
// back out, and `removeSections` is how a whole note is injected without the
// sections that are injected separately. Both are the read side of
// `appendToSection`, so they share its fence awareness — a tech plan quoting a
// heading inside a code block must not be mistaken for that section.
// ---------------------------------------------------------------------------

describe('sectionText', () => {
  it('returns a section without its heading', () => {
    const body = ['## A', '', 'first', 'second', '', '## B', '', 'other', ''].join('\n');
    expect(sectionText(body, '## A')).toBe('first\nsecond');
  });

  it('returns undefined for a heading that is not there', () => {
    expect(sectionText('## A\n\nx\n', '## Missing')).toBeUndefined();
  });

  it('returns an empty string for a section with nothing in it', () => {
    expect(sectionText(['## A', '', '## B', '', 'x', ''].join('\n'), '## A')).toBe('');
  });

  it('ignores a heading inside a fenced code block', () => {
    const body = ['## Real', '', '```md', '## Review Notes', 'fake content', '```', ''].join('\n');
    expect(sectionText(body, '## Review Notes')).toBeUndefined();
    expect(sectionText(body, '## Real')).toContain('fake content');
  });

  it('reads the last section when it runs to the end of the body', () => {
    expect(sectionText(['# T', '', '## Last', '', 'tail', ''].join('\n'), '## Last')).toBe('tail');
  });
});

describe('removeSections', () => {
  it('removes a whole section, heading included', () => {
    const body = ['## A', '', 'keep', '', '## B', '', 'drop', '', '## C', '', 'keep too', ''].join('\n');
    const result = removeSections(body, ['## B']);
    expect(result).not.toContain('drop');
    expect(result).toContain('keep');
    expect(result).toContain('keep too');
    expect(result).toContain('## A');
    expect(result).not.toContain('## B');
  });

  it('leaves the body untouched when no named section is present', () => {
    const body = '## A\n\nx\n';
    expect(removeSections(body, ['## Nope'])).toBe(body);
  });

  it('removes several sections at once and keeps the rest in order', () => {
    const body = ['## A', 'a', '## B', 'b', '## C', 'c', ''].join('\n');
    expect(removeSections(body, ['## A', '## C'])).toBe('## B\nb');
  });

  it('does not remove a heading that only appears inside a fence', () => {
    const body = ['## A', '', '```md', '## B', 'fenced', '```', ''].join('\n');
    expect(removeSections(body, ['## B'])).toContain('fenced');
  });
});
