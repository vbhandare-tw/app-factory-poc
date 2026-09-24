/**
 * The slug a feature name becomes (plan Phase 8). `POST /api/features` and `factory feature add` both use
 * `slugify` from `src/domain/ids.ts`; `dashboard-ui/slug.js` mirrors it, checked by test/unit/dashboard-ui/slug.test.ts.
 */
import { slugify } from '../domain/ids.js';

export function featureSlug(name: string): string {
  return slugify(name);
}
