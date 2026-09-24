/**
 * The add-feature form previews the id a name becomes (plan Phase 8). The
 * browser cannot import TypeScript, so `dashboard-ui/slug.js` mirrors the
 * server's rule; this table is what keeps the two in step.
 */
import { describe, expect, it } from 'vitest';

import { featureId as uiFeatureId, previewFeatureName as uiPreview, slugify as uiSlugify } from '../../../dashboard-ui/slug.js';
import { featureSlug } from '../../../src/dashboard/slug.js';
import { featureId, slugify } from '../../../src/domain/ids.js';
import { VaultPaths } from '../../../src/vault/paths.js';

/** What the server creates for a name: the slug `addFeature` accepts and its `featureId`, or null. */
function serverPreview(name: string): { slug: string; id: string } | null {
  const slug = slugify(name);
  return slug === '' || !VaultPaths.isSafeSegment(slug) ? null : { slug, id: featureId(slug) };
}

const NAMES = [
  'Expression calculator',
  'User Auth v2',
  '  Multi   space  ',
  'already-kebab-case',
  'Snake_case_name',
  'CamelCaseName',
  'Dots.and.more.dots',
  'Punctuation! Is? Fine...',
  'Crème brûlée ordering',
  'Überprüfung der Daten',
  '日本語の機能',
  'emoji 🚀 launch',
  '--leading and trailing--',
  'Feat login page',
  'FEAT-EXISTING-ID',
  'feat',
  '123 numbers first',
  'slash/and\\backslash',
  '../../etc/passwd',
  '!!!',
] as const;

describe('the UI slug mirror', () => {
  it('has a table of 20 names', () => {
    expect(NAMES).toHaveLength(20);
  });

  it.each(NAMES)('%j: the UI preview equals the server preview', (name) => {
    expect(uiPreview(name)).toEqual(serverPreview(name));
  });

  it.each(NAMES)('%j: the UI slugify equals the server slugify', (name) => {
    expect(uiSlugify(name)).toBe(slugify(name));
  });

  it.each(NAMES.filter((name) => slugify(name) !== ''))('%j: the UI featureId equals the server featureId', (name) => {
    expect(uiFeatureId(slugify(name))).toBe(featureId(slugify(name)));
  });
});

describe('the preview', () => {
  it('is the slug and id POST /api/features creates', () => {
    expect(uiPreview('Expression calculator')).toEqual({
      slug: 'expression-calculator',
      id: 'FEAT-EXPRESSION-CALCULATOR',
    });
    expect(featureSlug('Expression calculator')).toBe(slugify('Expression calculator'));
  });

  it('is null for a name with no usable characters', () => {
    expect(uiPreview('!!!')).toBeNull();
    expect(uiPreview('日本語の機能')).toBeNull();
    expect(uiPreview('')).toBeNull();
  });
});
