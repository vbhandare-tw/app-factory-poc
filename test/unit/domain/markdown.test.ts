import { describe, expect, it } from 'vitest';

import { findHeading, scanMarkdown, sectionEnd } from '../../../src/domain/markdown.js';

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
