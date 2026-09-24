export function slugify(input: string | null | undefined): string;
export function featureId(slug: string | null | undefined): string | null;
export function previewFeatureName(name: string | null | undefined): { slug: string; id: string } | null;
