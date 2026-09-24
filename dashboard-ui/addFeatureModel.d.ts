export interface FeatureSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
}

export const DEMO_REFUSAL: string;

export function blockingFeature<F extends FeatureSummary>(features: readonly F[] | null | undefined): F | null;
export function blockedText(feature: FeatureSummary): string;
export function draftState<F extends FeatureSummary>(
  draft: { name: string; requirement: string },
  features: readonly F[] | null | undefined,
  options?: { demo?: boolean },
): {
  preview: { slug: string; id: string } | null;
  blocker: F | null;
  duplicate: F | null;
  demoBlocked: boolean;
  canSubmit: boolean;
};
