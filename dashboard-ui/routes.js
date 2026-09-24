/** Hash routes (tech spec §6). Anything unrecognised opens the overview. */

export const FEATURE_TABS = ['overview', 'plan', 'tickets', 'history'];

const OVERVIEW = Object.freeze({ name: 'overview' });

export function parseRoute(hash) {
  let raw = String(hash ?? '');
  if (raw.startsWith('#')) raw = raw.slice(1);
  const q = raw.indexOf('?');
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  if (!pathPart.startsWith('/')) return { ...OVERVIEW };

  let parts;
  try {
    parts = pathPart.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return { ...OVERVIEW };
  }
  const [head, arg, ...rest] = parts;
  if (rest.length > 0) return { ...OVERVIEW };
  if (head === 'new' && arg === undefined) return { name: 'new' };
  if (arg === undefined || arg === '') return { ...OVERVIEW };

  switch (head) {
    case 'f': {
      const tab = query.get('tab');
      return { name: 'feature', slug: arg, tab: FEATURE_TABS.includes(tab) ? tab : 'overview' };
    }
    case 'i':
      return { name: 'item', id: arg };
    case 'review':
      return { name: 'review', id: arg };
    case 'run':
      return { name: 'run', runId: arg };
    default:
      return { ...OVERVIEW };
  }
}

export function href(route) {
  const e = encodeURIComponent;
  switch (route.name) {
    case 'new':
      return '#/new';
    case 'feature':
      return `#/f/${e(route.slug)}${route.tab && route.tab !== 'overview' ? `?tab=${e(route.tab)}` : ''}`;
    case 'item':
      return `#/i/${e(route.id)}`;
    case 'review':
      return `#/review/${e(route.id)}`;
    case 'run':
      return `#/run/${e(route.runId)}`;
    default:
      return '#/';
  }
}
