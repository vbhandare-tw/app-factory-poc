import type { Role } from './roles.js';

/**
 * Deterministic identifier construction (spec §3.6).
 *
 * No clock, no randomness, no counters hidden in module state: the same inputs
 * always produce the same id. These strings become filenames, git branch
 * names, worktree directory names and `.runs/<run-id>.json` keys, so they are
 * restricted to `[A-Za-z0-9_-]`.
 */

const FEATURE_PREFIX = 'FEAT-';

/** Normalise arbitrary text into an uppercase, hyphen-separated token. */
function normalise(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Lowercase kebab form of arbitrary text — used for vault directory names. */
export function slugify(input: string): string {
  return normalise(input).toLowerCase();
}

/**
 * `featureId('user-auth')` → `FEAT-USER-AUTH`.
 *
 * Idempotent: feeding an existing id back in returns it unchanged, so callers
 * never have to know whether they are holding a slug or an id.
 */
export function featureId(slug: string): string {
  const normalised = normalise(slug);
  if (normalised.length === 0) {
    throw new Error(`featureId: slug has no usable characters: ${JSON.stringify(slug)}`);
  }
  const withoutPrefix = normalised.startsWith(FEATURE_PREFIX)
    ? normalised.slice(FEATURE_PREFIX.length)
    : normalised;
  if (withoutPrefix.length === 0) {
    throw new Error(`featureId: slug has no usable characters: ${JSON.stringify(slug)}`);
  }
  return `${FEATURE_PREFIX}${withoutPrefix}`;
}

/**
 * `ticketId('FEAT-USER-AUTH', 3)` → `FEAT-USER-AUTH-T003`.
 *
 * Zero-padded to three digits, but not truncated: ordinal 1000 becomes `T1000`
 * so ids stay unique past 999.
 */
export function ticketId(featureIdentifier: string, ordinal: number): string {
  if (featureIdentifier.length === 0) {
    throw new Error('ticketId: feature id must not be empty');
  }
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`ticketId: ordinal must be a positive integer, got ${ordinal}`);
  }
  return `${featureIdentifier}-T${String(ordinal).padStart(3, '0')}`;
}

/**
 * `runId('FEAT-X-T001', 'developer', 2, 7)` → `FEAT-X-T001-developer-a2-7`.
 *
 * The counter is supplied by the caller (a per-process monotonic integer), not
 * generated here, so this stays pure and test runs are reproducible.
 */
export function runId(itemId: string, role: Role, attempt: number, counter: number): string {
  if (itemId.length === 0) {
    throw new Error('runId: item id must not be empty');
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`runId: attempt must be a non-negative integer, got ${attempt}`);
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`runId: counter must be a non-negative integer, got ${counter}`);
  }
  return `${itemId}-${role}-a${attempt}-${counter}`;
}
