export type FeatureTab = 'overview' | 'plan' | 'tickets' | 'history';

export type Route =
  | { name: 'overview' }
  | { name: 'new' }
  | { name: 'feature'; slug: string; tab: FeatureTab }
  | { name: 'item'; id: string }
  | { name: 'review'; id: string }
  | { name: 'run'; runId: string };

export const FEATURE_TABS: readonly FeatureTab[];
export function parseRoute(hash: string | null | undefined): Route;
export function href(route: Route): string;
