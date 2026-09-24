export function escapeHtml(value: unknown): string;
/** Safe HTML: every source character escaped, only allowlisted elements emitted. */
export function renderMarkdown(source: string | null | undefined): string;
export function unwrapMarkdownFence(text: string | null | undefined): string | null;
