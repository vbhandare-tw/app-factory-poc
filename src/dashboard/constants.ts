/** Dashboard constants (tech spec §1). Pure values, no I/O. */

/** Loopback only — never `0.0.0.0` or `localhost`, which can resolve to `::`. */
export const DASHBOARD_HOST = '127.0.0.1';

/** Arbitrary, unlikely to clash. A busy port fails with a clear message, no auto-increment. */
export const DEFAULT_DASHBOARD_PORT = 4317;

/** Keeps idle SSE connections open through the browser's timeouts. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Collapses a burst of vault writes (one transition writes several files) into one change. */
export const WATCH_DEBOUNCE_MS = 250;

/** A tail re-reads at least this often, because macOS can drop a change event. */
export const TAIL_POLL_MS = 1_000;

/** How often the host re-reads its mode, for changes no file shows: a foreign pid that died (tech spec §4.1). */
export const MODE_CHECK_MS = 5_000;

/** Initial slice of a transcript; older lines are paged in on request. */
export const TRANSCRIPT_PAGE_LINES = 400;

/** Tool results are truncated in the readable view; the raw view is untruncated. */
export const TOOL_RESULT_PREVIEW_CHARS = 2_000;

/** `Host` header allowlist for one running server (§2, DNS-rebinding guard). */
export function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Largest JSON request body a handler will read (plan Phase 3). */
export const MAX_BODY_BYTES = 1_048_576;

/** A gate log is returned as its last this-many bytes; test output fails at the end. */
export const GATE_LOG_CAP_BYTES = 256 * 1024;

/** `POST /api/features` in a demo vault: the DemoRunner only has a script for the demo feature. */
export const DEMO_ADD_FEATURE_REFUSAL =
  'The demo runs one scripted feature. Use `factory dashboard` on a real project to add your own.';

export const ACTIVITY_DEFAULT_LIMIT = 100;
export const ACTIVITY_MAX_LIMIT = 1_000;
