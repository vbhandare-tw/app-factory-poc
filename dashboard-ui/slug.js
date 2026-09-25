/**
 * The slug and id a feature name becomes. Mirrors `slugify`/`featureId` in src/domain/ids.ts
 * (the server stays the authority); test/unit/dashboard-ui/slug.test.ts fails if they drift.
 */

const FEATURE_PREFIX = 'FEAT-';

function normalise(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function slugify(input) {
  return normalise(input).toLowerCase();
}

/** `null` where the server's `featureId` would throw. */
export function featureId(slug) {
  const normalised = normalise(slug);
  const rest = normalised.startsWith(FEATURE_PREFIX) ? normalised.slice(FEATURE_PREFIX.length) : normalised;
  return rest.length === 0 ? null : `${FEATURE_PREFIX}${rest}`;
}

export function previewFeatureName(name) {
  const slug = slugify(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug.includes('..')) return null;
  const id = featureId(slug);
  return id === null ? null : { slug, id };
}
