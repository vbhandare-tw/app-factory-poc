/** The stylesheet must not undo the `hidden` attribute (a `display` on a class beats the UA rule). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dashboard-ui', 'styles.css'),
  'utf8',
);

describe('styles.css', () => {
  it('forces [hidden] elements to stay hidden whatever their class sets', () => {
    expect(CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('lets the ticket board fit nine columns in the main area at about 1440 px', () => {
    const min = /\.board\s*\{[^}]*grid-auto-columns:\s*minmax\((\d+)px/.exec(CSS)?.[1];
    expect(Number(min)).toBeLessThanOrEqual(120);
  });
});
