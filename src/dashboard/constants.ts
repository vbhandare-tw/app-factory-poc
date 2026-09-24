/** Dashboard constants (tech spec §1). Pure values, no I/O. */

/** Loopback only — never `0.0.0.0` or `localhost`, which can resolve to `::`. */
export const DASHBOARD_HOST = '127.0.0.1';

/** Arbitrary, unlikely to clash. A busy port fails with a clear message, no auto-increment. */
export const DEFAULT_DASHBOARD_PORT = 4317;

/** Keeps idle SSE connections open through the browser's timeouts. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Collapses a burst of vault writes (one transition writes several files) into one change. */
export const WATCH_DEBOUNCE_MS = 250;

/** Initial slice of a transcript; older lines are paged in on request. */
export const TRANSCRIPT_PAGE_LINES = 400;

/** Tool results are truncated in the readable view; the raw view is untruncated. */
export const TOOL_RESULT_PREVIEW_CHARS = 2_000;

/** Demo agents pause this long so the UI visibly moves. */
export const DEMO_STEP_DELAY_MS = 3_000;

/** `Host` header allowlist for one running server (§2, DNS-rebinding guard). */
export function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Largest JSON request body a handler will read (plan Phase 3). */
export const MAX_BODY_BYTES = 1_048_576;

/** A gate log is returned as its last this-many bytes; test output fails at the end. */
export const GATE_LOG_CAP_BYTES = 256 * 1024;

export const ACTIVITY_DEFAULT_LIMIT = 100;
export const ACTIVITY_MAX_LIMIT = 1_000;
