/** Hash routes (tech spec §6, plan Phase 7). */
import { describe, expect, it } from 'vitest';

import { FEATURE_TABS, href, parseRoute } from '../../../dashboard-ui/routes.js';
import type { Route } from '../../../dashboard-ui/routes.js';

describe('href → parseRoute round trip', () => {
  const routes: Route[] = [
    { name: 'overview' },
    { name: 'new' },
    ...FEATURE_TABS.map((tab): Route => ({ name: 'feature', slug: 'expression-calculator', tab })),
    { name: 'item', id: 'FEAT-CALC-T001' },
    { name: 'review', id: 'FEAT-CALC' },
    { name: 'run', runId: 'FEAT-CALC-T001-developer-a1-3' },
    { name: 'item', id: 'odd id/with?chars#&' },
    { name: 'run', runId: 'ünïcode-run' },
  ];

  it.each(routes.map((route) => [JSON.stringify(route), route] as const))('%s', (_label, route) => {
    expect(parseRoute(href(route))).toEqual(route);
  });

  it('writes the documented hashes', () => {
    expect(href({ name: 'overview' })).toBe('#/');
    expect(href({ name: 'new' })).toBe('#/new');
    expect(href({ name: 'feature', slug: 'calc', tab: 'overview' })).toBe('#/f/calc');
    expect(href({ name: 'feature', slug: 'calc', tab: 'tickets' })).toBe('#/f/calc?tab=tickets');
    expect(href({ name: 'item', id: 'T1' })).toBe('#/i/T1');
    expect(href({ name: 'review', id: 'T1' })).toBe('#/review/T1');
    expect(href({ name: 'run', runId: 'R1' })).toBe('#/run/R1');
  });
});

describe('parseRoute', () => {
  it.each(['', '#', '#/', '#/nowhere', '#/f/', '#/i', '#/run/', '#/f/a/b', 'garbage', '#/i/%E0%A4%A'])(
    'an unknown or malformed hash %j → overview',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ name: 'overview' });
    },
  );

  it('a feature with an unknown or missing tab opens its overview tab', () => {
    expect(parseRoute('#/f/calc?tab=secrets')).toEqual({ name: 'feature', slug: 'calc', tab: 'overview' });
    expect(parseRoute('#/f/calc')).toEqual({ name: 'feature', slug: 'calc', tab: 'overview' });
  });

  it('accepts a hash without the leading #', () => {
    expect(parseRoute('/i/T1')).toEqual({ name: 'item', id: 'T1' });
  });
});
