/**
 * Every vault path is derived here and nowhere else.
 *
 * Two reasons. First, the layout is only half-specified — spec §6 fixes
 * `work/features/<slug>/feature.md`, §7.4 fixes `.factory.lock`, §9 fixes
 * `.kill` and §12 fixes the log paths, but the ticket and tech-plan paths are
 * this module's choice. One place to change beats a search-and-replace.
 *
 * Second, and more important: a slug or ticket id reaching this layer comes
 * from a file on disk or from an agent's structured output. Neither is trusted.
 * A `../` in a slug would put an orchestrator write outside the vault, so every
 * caller-supplied segment is validated rather than merely joined.
 */
import path from 'node:path';

export class VaultPathError extends Error {
  readonly segment: string;

  constructor(segment: string, detail: string) {
    super(`unsafe vault path segment ${JSON.stringify(segment)}: ${detail}`);
    this.name = 'VaultPathError';
    this.segment = segment;
  }
}

/**
 * Deliberately strict: must start with a letter or digit, then letters, digits,
 * dot, dash or underscore. That rejects `..`, `.hidden`, `a/b`, `~`, absolute
 * paths, spaces and NUL in one rule, and it covers every id `src/domain/ids.ts`
 * can generate.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class VaultPaths {
  /** Absolute, with no trailing separator. */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  static isSafeSegment(value: string): boolean {
    return SAFE_SEGMENT.test(value) && !value.includes('..');
  }

  // --- vault root files ---------------------------------------------------

  configFile(): string {
    return this.inside('config.yml');
  }

  projectFile(): string {
    return this.inside('project.md');
  }

  indexFile(): string {
    return this.inside('index.md');
  }

  needsHumanFile(): string {
    return this.inside('NEEDS_HUMAN.md');
  }

  /** Instance lock, spec §7.4. */
  instanceLock(): string {
    return this.inside('.factory.lock');
  }

  /** `factory kill` drops this, loop step 1 reads it (spec §9). */
  killFile(): string {
    return this.inside('.kill');
  }

  // --- run registry and logs ----------------------------------------------

  runsDir(): string {
    return this.inside('.runs');
  }

  runFile(runId: string): string {
    return this.inside('.runs', `${segment(runId)}.json`);
  }

  logsDir(): string {
    return this.inside('logs');
  }

  /** `<vault>/logs/orchestrator.jsonl` (spec §12). */
  eventLog(): string {
    return this.inside('logs', 'orchestrator.jsonl');
  }

  featureLogDir(slug: string): string {
    return this.inside('logs', segment(slug));
  }

  /** `logs/<slug>/<item-id>-<attempt>-<role>.log` (spec §12). */
  logPath(slug: string, itemId: string, attempt: number, role: string): string {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new VaultPathError(String(attempt), 'attempt must be a non-negative integer');
    }
    return this.inside(
      'logs',
      segment(slug),
      `${segment(itemId)}-${attempt}-${segment(role)}.log`,
    );
  }

  // --- work tree ------------------------------------------------------------

  /** Project-level technical documents, copied from `vault-template/`. */
  techDir(): string {
    return this.inside('tech');
  }

  featuresDir(): string {
    return this.inside('work', 'features');
  }

  featureDir(slug: string): string {
    return this.inside('work', 'features', segment(slug));
  }

  /** `work/features/<slug>/feature.md` (spec §6). */
  featureNote(slug: string): string {
    return this.inside('work', 'features', segment(slug), 'feature.md');
  }

  /** The TL's output, injected into the DL and Developer context (spec §6.2). */
  techPlan(slug: string): string {
    return this.inside('work', 'features', segment(slug), 'tech-plan.md');
  }

  ticketsDir(slug: string): string {
    return this.inside('work', 'features', segment(slug), 'tickets');
  }

  ticketPath(slug: string, ticketId: string): string {
    return this.inside('work', 'features', segment(slug), 'tickets', `${segment(ticketId)}.md`);
  }

  /**
   * Join and prove containment.
   *
   * The segment validator should already make this impossible, so a throw here
   * means the validator has a hole. Belt and braces on purpose: this is the
   * last thing standing between an untrusted slug and a write outside the vault.
   */
  private inside(...parts: string[]): string {
    const full = path.resolve(this.root, ...parts);
    // `path.resolve('/')` keeps its trailing separator, so appending another
    // would build `//` and make every child of the filesystem root look like an
    // escape. Found by the Phase 4 resolution walk, which constructs a
    // `VaultPaths` for each ancestor on the way up and therefore reaches `/`.
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (full !== this.root && !full.startsWith(prefix)) {
      throw new VaultPathError(parts.join('/'), `resolves outside the vault root ${this.root}`);
    }
    return full;
  }
}

function segment(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultPathError(String(value), 'must be a non-empty string');
  }
  if (!VaultPaths.isSafeSegment(value)) {
    throw new VaultPathError(
      value,
      'must match [A-Za-z0-9][A-Za-z0-9._-]* — no separators, no dot segments, no traversal',
    );
  }
  return value;
}
