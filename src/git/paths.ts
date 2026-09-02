/**
 * Where worktrees live, and what their branches are called.
 *
 * ============================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE — plan Section E item 7
 * ============================================================================
 * **A worktree must never live under a temp path.** The sandbox's default
 * *write* allowlist covers the process cwd, `$TMPDIR` and `/tmp/claude*` (spec
 * §4.2). A worktree under any of those is writable by every sandboxed agent on
 * the machine, so the kernel fence that ADR-003 rests on quietly does nothing —
 * and *every test still passes*, because a unit test on a path string asserts
 * against the same constant the implementation used, and
 * `isolation.test.ts` builds its own worktrees rather than asking for one.
 *
 * During Gate 2's verification the sandbox "appeared to fail" until the probe
 * was moved out of `/private/tmp/claude-*`. That is the whole story: the
 * failure looks like the fence not working, and the fix looks like moving a
 * directory, so it is very easy to conclude the fence is fine and move on.
 *
 * So the rule is enforced **at runtime, in production code**, by
 * `assertNotUnderTempRoot` below — not only asserted in a test. A future config
 * change, a `FACTORY_TEST_ROOT` pointed somewhere convenient, or a symlinked
 * parent that resolves into `/private/var` hits an exception rather than a
 * silent unfencing. `test/helpers/toyRepo.ts` carries the identical guard for
 * test repos, for the same reason and against the same list.
 *
 * ============================================================================
 * LAYOUT (spec §10)
 * ============================================================================
 *   <repo>/../.factory-worktrees/<vault-name>-<salt>/<ticket-id>    ticket worktrees
 *   <repo>/../.factory-worktrees/<vault-name>-<salt>/.scratch/<id>  throwaway worktrees
 *
 * Outside the repo, so no `.gitignore` entry is needed and no gate can glob
 * another ticket's tree.
 *
 * **`-<salt>` is a deliberate deviation from spec §10's literal `<vault-name>`.**
 * See `vaultWorktreeName`: the bare name collides when two vaults share a
 * directory name and their repos share a parent, and the consequence of that
 * collision is one vault's reconciliation deleting the other's worktrees.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The directory that holds every worktree, as a sibling of the target repo. */
export const WORKTREES_DIR_NAME = '.factory-worktrees';

/** Throwaway worktrees (spec §4.3) live under this, one level down. */
export const SCRATCH_DIR_NAME = '.scratch';

/** How much of a ticket title survives into its branch name. */
export const MAX_TITLE_SEGMENT_CHARS = 40;

/** What a title sanitises to when it has no usable characters at all. */
export const EMPTY_TITLE_PLACEHOLDER = 'untitled';

export class UnsafeWorktreePathError extends Error {
  readonly candidate: string;

  constructor(candidate: string, detail: string) {
    super(`refusing to use ${candidate} as a worktree location: ${detail}`);
    this.name = 'UnsafeWorktreePathError';
    this.candidate = candidate;
  }
}

/**
 * Every temp root a worktree must not be under.
 *
 * `os.tmpdir()` is included as well as the literals because it is
 * `$TMPDIR`-driven and on macOS resolves to a per-user `/var/folders/...`
 * directory that matches none of the others by name. `/private/tmp` and
 * `/private/var` are macOS's real locations for `/tmp` and `/var`; a path that
 * arrives already resolved (as `fs.realpath` returns it, and as the sandbox
 * matches it) looks like neither `/tmp` nor `$TMPDIR` without them.
 */
export function tempRoots(): string[] {
  const declared = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
  // Each root is listed *and* resolved through symlinks: on macOS `/tmp` is
  // itself a symlink to `/private/tmp`, so a candidate that arrives already
  // real matches only the resolved spelling, and one that arrives as written
  // matches only the declared one. Both are needed.
  const all = declared.flatMap((dir) => [path.resolve(dir), realPathOf(dir)]);
  return all.filter((dir, index) => all.indexOf(dir) === index);
}

/**
 * A path with every symlink in it followed, as far as the filesystem allows.
 *
 * `path.resolve` alone is not enough, and the difference is the whole point of
 * this module. `path.resolve` collapses `.` and `..` **lexically** — it never
 * touches the disk, so `/somewhere/link-into-tmpdir/repo` resolves to itself
 * and sails past a check that only compares prefixes. The kernel sandbox, by
 * contrast, matches on the *real* path, so a repo reached through such a link
 * is fenced (or rather, not fenced) as though it were in `$TMPDIR`.
 *
 * The path being checked usually does not exist yet — it is about to be
 * created — so `realpathSync` on the whole thing would throw. This walks up to
 * the deepest ancestor that *does* exist, resolves that, and re-attaches the
 * not-yet-created tail. That is exactly the part a symlink can hide in: a
 * component that does not exist cannot be a link.
 */
export function realPathOf(candidate: string): string {
  const resolved = path.resolve(candidate);
  const tail: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // Root reached with nothing resolvable: there is no symlink to follow,
      // so the lexical answer is the only answer.
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The runtime half of Section E item 7. Called on every worktree path before it
 * is created, and on the root before anything is derived from it.
 *
 * Checks the path **both** as written and as the filesystem really sees it. A
 * symlinked parent pointing into a temp root is the case that used to slip
 * through, and it is the one an operator is least likely to notice, because the
 * path they typed looks entirely ordinary.
 */
export function assertNotUnderTempRoot(candidate: string, what = 'worktree'): void {
  const lexical = path.resolve(candidate);
  const real = realPathOf(candidate);

  for (const root of tempRoots()) {
    for (const resolved of lexical === real ? [lexical] : [lexical, real]) {
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;

      const via =
        resolved === real && lexical !== real
          ? ` (reached through a symlink: ${lexical} really is ${real})`
          : '';
      throw new UnsafeWorktreePathError(
        lexical,
        `it is under the temp path ${root}${via}. The sandbox's default write allowlist covers ` +
          'the process cwd, $TMPDIR and /tmp/claude* (spec §4.2), so a ' +
          `${what} there is writable by every sandboxed agent and the kernel fence ADR-003 ` +
          'depends on silently does nothing. Plan Section E item 7. Move the target repo ' +
          'somewhere that is not a temp path.',
      );
    }
  }
}

/** `<repo>/../.factory-worktrees/<vault-name>-<salt>`, checked. */
export function worktreeRoot(repoRoot: string, vaultName: string): string {
  const repo = path.resolve(repoRoot);
  // Checked before deriving, because the root is a *sibling* of the repo: a
  // repo in a temp path puts its worktrees in one too, and the derived path is
  // what would otherwise be the first thing anybody looked at.
  assertNotUnderTempRoot(repo, 'target repository');

  const name = safeVaultName(vaultName);
  const root = path.join(path.dirname(repo), WORKTREES_DIR_NAME, name);
  assertNotUnderTempRoot(root, 'worktree root');
  return root;
}

/** `<worktree-root>/<ticket-id>`. */
export function ticketWorktreePath(repoRoot: string, vaultName: string, ticketId: string): string {
  const segment = safeSegment(ticketId, 'ticket id');
  const worktree = path.join(worktreeRoot(repoRoot, vaultName), segment);
  assertNotUnderTempRoot(worktree, 'ticket worktree');
  assertOutsideRepo(worktree, repoRoot);
  return worktree;
}

/** `<worktree-root>/.scratch/<label>` — a throwaway worktree (spec §4.3). */
export function scratchWorktreePath(repoRoot: string, vaultName: string, label: string): string {
  const segment = safeSegment(label, 'scratch label');
  const worktree = path.join(worktreeRoot(repoRoot, vaultName), SCRATCH_DIR_NAME, segment);
  assertNotUnderTempRoot(worktree, 'scratch worktree');
  assertOutsideRepo(worktree, repoRoot);
  return worktree;
}

/** `<worktree-root>/.scratch`. */
export function scratchRoot(repoRoot: string, vaultName: string): string {
  return path.join(worktreeRoot(repoRoot, vaultName), SCRATCH_DIR_NAME);
}

/**
 * A worktree inside the repo would be inside the gitignore-free tree every gate
 * globs, and `git worktree add` into your own working tree is a mess nobody
 * wants to debug. Spec §10 says outside; this is the check.
 */
export function assertOutsideRepo(candidate: string, repoRoot: string): void {
  const repo = path.resolve(repoRoot);
  const resolved = path.resolve(candidate);
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new UnsafeWorktreePathError(
      resolved,
      `it is inside the target repository ${repo}. Spec §10 puts worktrees outside the repo so ` +
        'no gate can glob another ticket’s tree and no .gitignore entry is needed.',
    );
  }
}

/**
 * The vault's own directory name plus a salt derived from its full path.
 *
 * ============================================================================
 * WHY THE SALT
 * ============================================================================
 * Spec §10 keys the worktree root on `<vault-name>`. Two vaults whose
 * directories share a *name*, pointed at two repos that share a *parent*, then
 * land on one root — and the consequence is not a confusing directory listing.
 * Reconciliation for vault B lists the shared root, sees vault A's ticket
 * directories, finds no ticket of its own with those ids, and (before this) its
 * scratch sweep would remove A's throwaway trees outright. Agents never commit
 * (ADR-003), so a wrongly-removed worktree is work that exists nowhere else.
 *
 * The salt is eight hex characters of the vault's absolute path, so two vaults
 * can never collide however they are named or wherever their repos live. It is
 * a deliberate, recorded deviation from spec §10's literal `<vault-name>`: the
 * spec picked a name for legibility, and legibility survives — `my-vault-3f2a11c8`
 * is still obviously `my-vault`.
 *
 * Deterministic, so the same vault always finds its own worktrees again after a
 * restart. Derived rather than configured, so there is nothing an operator can
 * set to two identical values by accident.
 */
export function vaultWorktreeName(vaultRoot: string): string {
  // The *real* path, so a vault reached through a symlink and the same vault
  // reached directly agree about where their worktrees are.
  const resolved = realPathOf(vaultRoot);
  const salt = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${safeVaultName(path.basename(resolved))}-${salt}`;
}

// ---------------------------------------------------------------------------
// Branch names.
// ---------------------------------------------------------------------------

/** `feature/<slug>` (spec §10). */
export function featureBranchName(slug: string): string {
  return `feature/${refComponent(slug, 'feature slug')}`;
}

/**
 * `factory/<slug>/<ISO date>` — the tag the feature close puts on the base
 * branch (spec §10, plan Phase 11).
 *
 * **Deterministic from the slug and the date, and nothing else.** No counter, no
 * clock read of its own, no SHA: the same feature closed on the same day always
 * produces the same name, which is what makes a collision *detectable* rather
 * than avoided by luck. `closeFeature` refuses rather than reusing one — see its
 * own note; a name that quietly gained a `-2` suffix would make this function's
 * only interesting property false.
 *
 * The date component is sliced from an ISO timestamp rather than formatted from
 * a `Date`, so it is the caller's clock (`deps.now()`) all the way through and a
 * test can pin it. The shape is asserted rather than trusted: a caller that
 * passed `Date.now()` as a number, or a localised date string, would otherwise
 * produce a tag nobody could predict and, with a `/` in it, a whole extra ref
 * directory.
 *
 * Lives here beside `featureBranchName` because git-ref construction is one
 * concern with one sanitiser — `test/unit/git/paths.test.ts` checks the output
 * against the real `git check-ref-format` rather than against a regex of ours.
 */
export function featureTagName(slug: string, isoTimestamp: string): string {
  const date = isoTimestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `featureTagName: ${JSON.stringify(isoTimestamp)} does not start with an ISO date ` +
        '(YYYY-MM-DD), so no deterministic tag name can be derived from it.',
    );
  }
  return `factory/${refComponent(slug, 'feature slug')}/${date}`;
}

/**
 * `feat/<slug>/t00N-<short-title>` (spec §10).
 *
 * The ordinal comes from the ticket id rather than being passed separately, so
 * the branch and the id can never disagree about which ticket this is.
 *
 * **Sanitising is deliberately aggressive: the result is ASCII `[a-z0-9-]` and
 * nothing else.** git's own rules are much more permissive — a ref may hold any
 * UTF-8 that is not one of a dozen forbidden sequences — but "permissive with
 * exceptions" is exactly the shape that produces a branch name which works for
 * a year and then meets a title with a `~` in it. A branch name is also a
 * directory name under `.git/refs/`, a shell argument in every gate log, and a
 * thing a human types. Losing the unicode in a title costs nothing: the title
 * itself is in the ticket note, which is where anybody actually reads it.
 *
 * `test/unit/git/paths.test.ts` checks the output with the real
 * `git check-ref-format`, not with a regex of our own — a regex here would only
 * restate the belief that produced the sanitiser.
 */
export function ticketBranchName(
  featureSlug: string,
  ticketIdentifier: string,
  title: string,
): string {
  const slug = refComponent(featureSlug, 'feature slug');
  const ordinal = ticketOrdinalSegment(ticketIdentifier);
  const short = shortTitle(title);
  return `feat/${slug}/${ordinal}-${short}`;
}

/** `FEAT-ALPHA-T003` → `t003`. */
export function ticketOrdinalSegment(ticketIdentifier: string): string {
  const parts = ticketIdentifier.split('-');
  const last = parts[parts.length - 1] ?? '';
  const ordinal = last.toLowerCase();
  if (!/^t\d+$/.test(ordinal)) {
    throw new Error(
      `ticket id ${JSON.stringify(ticketIdentifier)} does not end in a T<ordinal> segment, so no ` +
        'branch name can be derived from it (spec §3.6 generates them as FEAT-<SLUG>-T00N).',
    );
  }
  return ordinal;
}

/** The `<short-title>` half of a ticket branch. Exported for the unit tests. */
export function shortTitle(title: string): string {
  const sanitised = sanitiseRefText(title);
  if (sanitised === '') return EMPTY_TITLE_PLACEHOLDER;
  if (sanitised.length <= MAX_TITLE_SEGMENT_CHARS) return sanitised;

  const cut = sanitised.slice(0, MAX_TITLE_SEGMENT_CHARS);
  // Prefer a word boundary, but only if one survives — truncating "a-very-long
  // -single-word" at the last dash would otherwise return almost nothing.
  const lastDash = cut.lastIndexOf('-');
  const trimmed = lastDash > MAX_TITLE_SEGMENT_CHARS / 2 ? cut.slice(0, lastDash) : cut;
  const cleaned = trimmed.replace(/-+$/, '');
  return cleaned === '' ? EMPTY_TITLE_PLACEHOLDER : cleaned;
}

/**
 * Arbitrary text → `[a-z0-9-]`.
 *
 * `NFKD` first so `café` becomes `cafe` rather than `caf`, and CJK or emoji
 * (which decompose to nothing ASCII) collapse to separators and are then
 * trimmed. Nothing here can emit `..`, `@{`, a leading `.`, a trailing `.lock`,
 * a control character, or a double slash, which is every rule
 * `git check-ref-format` enforces on a single component.
 */
export function sanitiseRefText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function refComponent(text: string, what: string): string {
  const sanitised = sanitiseRefText(text);
  if (sanitised === '') {
    throw new Error(`${what} ${JSON.stringify(text)} has no characters usable in a git ref`);
  }
  return sanitised;
}

/**
 * A path segment that came from a note on disk or an agent payload.
 *
 * Same reasoning as `src/vault/paths.ts`: a `../` here would put a worktree —
 * and therefore an agent's kernel write region — somewhere nobody chose.
 */
function safeSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new UnsafeWorktreePathError(
      value,
      `${what} ${JSON.stringify(value)} is not a safe path segment. A traversal here would put ` +
        'an agent’s sandbox write region somewhere nobody chose.',
    );
  }
  return value;
}

function safeVaultName(value: string): string {
  const sanitised = sanitiseRefText(value);
  if (sanitised === '') {
    throw new UnsafeWorktreePathError(
      value,
      'the vault directory name has no usable characters, so its worktrees would have no home ' +
        'of their own and could collide with another vault’s',
    );
  }
  return sanitised;
}
