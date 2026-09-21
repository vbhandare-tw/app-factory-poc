/**
 * Frontmatter parse and serialize (spec §7.2).
 *
 * Two failure modes drive every decision in this file, and neither is loud:
 *
 * 1. **Silent retyping.** A YAML emitter that writes `created_at:
 *    2026-08-31T10:00:00Z` unquoted is correct under the YAML 1.2 core schema
 *    and *wrong* under YAML 1.1, which Obsidian and js-yaml still use — there it
 *    becomes a Date. The same trap catches `no` → false, `y` → true, `~` →
 *    null, `012` → 10, and `T001` → a string only by luck. So every string is
 *    emitted double-quoted. It is slightly noisier to read and it removes the
 *    entire class of bug.
 *
 * 2. **Reformat churn.** If serializing a parsed note re-quotes, reorders or
 *    re-wraps anything, every state transition rewrites the whole file and the
 *    git history stops being readable — which is the entire justification for
 *    ADR-001. So the emitter is deterministic: fixed key order, fixed quoting,
 *    no line wrapping, and one canonical form that is a fixed point.
 */
import matter from 'gray-matter';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Note } from '../domain/types.js';

const FENCE = '---';

/**
 * The canonical frontmatter key order.
 *
 * Grouped by what a human scanning a note wants first: identity, then position
 * in the pipeline, then accounting, then git, then timestamps, then the pause
 * and lock machinery that is null almost all of the time.
 *
 * `test/unit/vault/note.test.ts` proves at compile time that this tuple names
 * every field on `FeatureFrontmatter` and `TicketFrontmatter` and no others, so
 * adding a domain field without adding it here is a build failure, not a
 * silently misordered note.
 */
export const FRONTMATTER_ORDER = [
  // identity
  'type',
  'id',
  'title',
  'status',
  // position
  'slug',
  'feature',
  'ordinal',
  'priority',
  'depends_on',
  // accounting
  'attempts',
  'max_attempts',
  'cost_usd',
  // git
  'feature_branch',
  'branch',
  'worktree',
  'tag',
  // verification
  'gate_results',
  'verified_sha',
  'base_verified_sha',
  'approved_sha',
  'approved_note',
  'approved_tag',
  // timestamps
  'created_at',
  'updated_at',
  // claim
  'locked_by',
  'locked_at',
  // pause
  'pause_reason',
  'pause_detail',
  'resume_to',
  'reject_to',
  'paused_at',
] as const;

const ORDERED = new Set<string>(FRONTMATTER_ORDER);

/** Thrown when a file is not a readable note. Always names the file. */
export class NoteParseError extends Error {
  readonly source: string;

  constructor(source: string, detail: string, options?: { cause?: unknown }) {
    super(`${source}: ${detail}`, options);
    this.name = 'NoteParseError';
    this.source = source;
  }
}

/**
 * YAML 1.2 core schema: no timestamp tag, and only `true`/`false` are booleans.
 * Anything else stays the string it looks like.
 */
const PARSE_OPTIONS = { schema: 'core' } as const;

const STRINGIFY_OPTIONS = {
  schema: 'core',
  /** See the header note — this is the whole defence against silent retyping. */
  defaultStringType: 'QUOTE_DOUBLE',
  defaultKeyType: 'PLAIN',
  /** Never fold a long value across lines: folding changes the value. */
  lineWidth: 0,
  nullStr: 'null',
  indent: 2,
} as const;

/**
 * Parse a note into frontmatter and body.
 *
 * `source` is the path used in error messages; a parse failure that does not
 * name the file is nearly useless when the orchestrator is scanning hundreds of
 * notes a cycle.
 */
export function parseNote<T>(raw: string, source = '<unknown>'): Note<T> {
  // Normalise line endings before anything sees them. gray-matter otherwise
  // leaves a trailing `\r` glued to the last value on every frontmatter line.
  const normalised = raw.replace(/\r\n/g, '\n');

  if (!normalised.startsWith(`${FENCE}\n`) && normalised.trimEnd() !== FENCE) {
    throw new NoteParseError(
      source,
      "no YAML frontmatter — a note must begin with a '---' fence on its own line",
    );
  }

  let file;
  try {
    file = matter(normalised, { engines: { yaml: parseFrontmatterBlock } });
  } catch (error) {
    throw new NoteParseError(
      source,
      `frontmatter is not valid YAML — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (file.matter === '') {
    throw new NoteParseError(
      source,
      "the opening '---' fence is never closed, so there is no frontmatter block",
    );
  }

  const data: unknown = file.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new NoteParseError(source, 'frontmatter must be a YAML mapping of key to value');
  }

  return { frontmatter: stripPrototypeKey(data as Record<string, unknown>) as T, body: file.content };
}

/**
 * Serialize a note back to markdown.
 *
 * Known keys first in `FRONTMATTER_ORDER`, then any key we do not recognise, in
 * the order it already had. Unknown keys are carried on the frontmatter object
 * itself rather than in a side channel, which is what makes them survive the
 * orchestrator's `{...frontmatter, status}` update path — a side channel would
 * be silently dropped by the very code that is supposed to preserve it.
 */
export function serializeNote<T>(note: Note<T>): string {
  const frontmatter: unknown = note.frontmatter;
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new TypeError('serializeNote: frontmatter must be a plain object');
  }

  return `${FENCE}\n${serializeFrontmatter(frontmatter as Record<string, unknown>)}${FENCE}\n${note.body}`;
}

/** The frontmatter block on its own, fence-free. Exposed for tests and tooling. */
export function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const emitted: string[] = [];

  for (const key of FRONTMATTER_ORDER) {
    if (!Object.hasOwn(frontmatter, key)) continue;
    const value = frontmatter[key];
    if (value === undefined) continue;
    emitted.push(emitPair(key, value));
  }

  for (const key of Object.keys(frontmatter)) {
    if (ORDERED.has(key)) continue;
    const value = frontmatter[key];
    if (value === undefined) continue;
    emitted.push(emitPair(key, value));
  }

  return emitted.join('');
}

/**
 * One `key: value` pair.
 *
 * Emitting a single-pair document per key is what makes the output ordered:
 * `yaml` handles indentation, quoting and empty-collection forms (`[]`, `{}`)
 * consistently, and we control nothing but the order the pairs are joined in.
 */
function emitPair(key: string, value: unknown): string {
  return stringifyYaml({ [key]: value }, STRINGIFY_OPTIONS);
}

/** The engine gray-matter uses, so js-yaml — and its 1.1 timestamps — never runs. */
function parseFrontmatterBlock(block: string): object {
  const parsed: unknown = parseYaml(block, PARSE_OPTIONS);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object') {
    throw new Error('frontmatter must be a mapping, not a bare scalar');
  }
  return parsed;
}

/**
 * Vault notes are human-editable, so `__proto__` can genuinely appear in one.
 * Move it to a normal own property rather than letting it reach the prototype.
 */
function stripPrototypeKey(data: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(data, '__proto__')) return data;
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    Object.defineProperty(safe, key, {
      value: data[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return safe;
}
