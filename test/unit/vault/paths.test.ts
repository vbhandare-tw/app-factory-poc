import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultPathError, VaultPaths } from '../../../src/vault/paths.js';

const ROOT = '/vaults/demo';
const paths = new VaultPaths(ROOT);

/** Every helper that takes no caller-supplied segment. */
const FIXED: ReadonlyArray<readonly [string, () => string]> = [
  ['configFile', () => paths.configFile()],
  ['projectFile', () => paths.projectFile()],
  ['indexFile', () => paths.indexFile()],
  ['needsHumanFile', () => paths.needsHumanFile()],
  ['instanceLock', () => paths.instanceLock()],
  ['killFile', () => paths.killFile()],
  ['runsDir', () => paths.runsDir()],
  ['logsDir', () => paths.logsDir()],
  ['eventLog', () => paths.eventLog()],
  ['techDir', () => paths.techDir()],
  ['featuresDir', () => paths.featuresDir()],
];

/** Every helper whose first argument is a caller-supplied slug. */
const SLUG_TAKING: ReadonlyArray<readonly [string, (slug: string) => string]> = [
  ['featureDir', (slug) => paths.featureDir(slug)],
  ['featureNote', (slug) => paths.featureNote(slug)],
  ['techPlan', (slug) => paths.techPlan(slug)],
  ['ticketsDir', (slug) => paths.ticketsDir(slug)],
  ['ticketPath', (slug) => paths.ticketPath(slug, 'FEAT-X-T001')],
  ['featureLogDir', (slug) => paths.featureLogDir(slug)],
  ['logPath', (slug) => paths.logPath(slug, 'FEAT-X-T001', 1, 'developer')],
  // Phase 9. Added to the shared list rather than tested on its own, so the
  // traversal and containment cases below cover it without being restated.
  ['gateLogPath', (slug) => paths.gateLogPath(slug, 'FEAT-X-T001', 1, 'tests')],
];

const HOSTILE_SEGMENTS = [
  '..',
  '../escape',
  'a/../../escape',
  '../../etc/passwd',
  'a/b',
  'a\\b',
  '/absolute',
  '~',
  '~/home',
  '',
  '.',
  '.hidden',
  'has space',
  'null\0byte',
  '-leading-dash',
];

describe('VaultPaths — containment', () => {
  it('resolves the root to an absolute path', () => {
    expect(path.isAbsolute(paths.root)).toBe(true);
  });

  it.each(FIXED)('%s stays inside the vault root', (_name, produce) => {
    const full = produce();
    expect(full.startsWith(`${ROOT}${path.sep}`)).toBe(true);
  });

  it.each(SLUG_TAKING)('%s stays inside the vault root for a normal slug', (_name, produce) => {
    const full = produce('user-auth');
    expect(full.startsWith(`${ROOT}${path.sep}`)).toBe(true);
    expect(path.resolve(full)).toBe(full);
  });

  for (const [name, produce] of SLUG_TAKING) {
    it.each(HOSTILE_SEGMENTS)(`${name} refuses the slug %j`, (slug) => {
      expect(() => produce(slug)).toThrowError(VaultPathError);
    });
  }

  it('refuses a hostile ticket id as firmly as a hostile slug', () => {
    for (const id of HOSTILE_SEGMENTS) {
      expect(() => paths.ticketPath('user-auth', id)).toThrowError(VaultPathError);
    }
  });

  it('refuses a hostile run id', () => {
    for (const id of HOSTILE_SEGMENTS) {
      expect(() => paths.runFile(id)).toThrowError(VaultPathError);
    }
  });

  it('refuses a hostile role in a log path', () => {
    expect(() => paths.logPath('user-auth', 'FEAT-X-T001', 1, '../../evil')).toThrowError(
      VaultPathError,
    );
  });

  it('refuses a negative or non-integer attempt number in a log path', () => {
    expect(() => paths.logPath('user-auth', 'FEAT-X-T001', -1, 'developer')).toThrowError(
      VaultPathError,
    );
    expect(() => paths.logPath('user-auth', 'FEAT-X-T001', 1.5, 'developer')).toThrowError(
      VaultPathError,
    );
  });

  it('names the offending segment in the error', () => {
    try {
      paths.featureDir('../escape');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultPathError);
      expect((error as VaultPathError).segment).toBe('../escape');
      expect((error as Error).message).toContain('../escape');
    }
  });
});

describe('VaultPaths — the layout itself', () => {
  it('puts features under work/features/<slug>/', () => {
    expect(paths.featureDir('user-auth')).toBe(path.join(ROOT, 'work', 'features', 'user-auth'));
    expect(paths.featureNote('user-auth')).toBe(
      path.join(ROOT, 'work', 'features', 'user-auth', 'feature.md'),
    );
    expect(paths.techPlan('user-auth')).toBe(
      path.join(ROOT, 'work', 'features', 'user-auth', 'tech-plan.md'),
    );
    expect(paths.ticketPath('user-auth', 'FEAT-USER-AUTH-T001')).toBe(
      path.join(ROOT, 'work', 'features', 'user-auth', 'tickets', 'FEAT-USER-AUTH-T001.md'),
    );
  });

  it('puts transcripts at logs/<slug>/<item>-<attempt>-<role>.log (spec §12)', () => {
    expect(paths.logPath('user-auth', 'FEAT-USER-AUTH-T001', 2, 'developer')).toBe(
      path.join(ROOT, 'logs', 'user-auth', 'FEAT-USER-AUTH-T001-2-developer.log'),
    );
    expect(paths.eventLog()).toBe(path.join(ROOT, 'logs', 'orchestrator.jsonl'));
  });

  it('puts gate output beside the transcripts, and never in their namespace', () => {
    // Phase 9. A gate is not a role, so `<item>-<attempt>-tests.log` would sit
    // in the same namespace as an agent transcript with nothing to tell them
    // apart — and the `gate-` infix is what keeps a role named `tests` from
    // ever colliding with the tests gate.
    expect(paths.gateLogPath('user-auth', 'FEAT-USER-AUTH-T001', 2, 'tests')).toBe(
      path.join(ROOT, 'logs', 'user-auth', 'FEAT-USER-AUTH-T001-2-gate-tests.log'),
    );
    expect(paths.gateLogPath('user-auth', 'FEAT-USER-AUTH-T001', 2, 'tests')).not.toBe(
      paths.logPath('user-auth', 'FEAT-USER-AUTH-T001', 2, 'tests'),
    );
    expect(() => paths.gateLogPath('user-auth', 'FEAT-X-T001', -1, 'tests')).toThrowError(
      /non-negative integer/,
    );
    expect(() => paths.gateLogPath('user-auth', 'FEAT-X-T001', 1, '../../evil')).toThrowError(
      VaultPathError,
    );
  });

  it('puts the control files where spec §7.4 and §9 say they are', () => {
    expect(paths.instanceLock()).toBe(path.join(ROOT, '.factory.lock'));
    expect(paths.killFile()).toBe(path.join(ROOT, '.kill'));
    expect(paths.runsDir()).toBe(path.join(ROOT, '.runs'));
    expect(paths.runFile('FEAT-X-T001-developer-a1-3')).toBe(
      path.join(ROOT, '.runs', 'FEAT-X-T001-developer-a1-3.json'),
    );
  });

  it('resolves a relative vault root against the process cwd once, at construction', () => {
    const relative = new VaultPaths('some/vault');
    expect(path.isAbsolute(relative.root)).toBe(true);
    expect(relative.configFile()).toBe(path.join(relative.root, 'config.yml'));
  });

  it('normalises a trailing separator on the root', () => {
    expect(new VaultPaths(`${ROOT}/`).root).toBe(ROOT);
  });

  it('works when the root is the filesystem root itself', () => {
    // `path.resolve('/')` keeps its trailing separator, so a naive containment
    // check builds `//` and rejects every child. The Phase 4 resolution walk
    // constructs a VaultPaths per ancestor on the way up, so it reaches `/` on
    // any command run from outside a vault — this threw before it was fixed.
    const root = new VaultPaths(path.parse(process.cwd()).root);
    expect(root.configFile()).toBe(path.join(root.root, 'config.yml'));
  });

  it('exposes a slug validator callers can use before building a path', () => {
    expect(VaultPaths.isSafeSegment('user-auth')).toBe(true);
    expect(VaultPaths.isSafeSegment('FEAT-X-T001')).toBe(true);
    expect(VaultPaths.isSafeSegment('../escape')).toBe(false);
    expect(VaultPaths.isSafeSegment('..')).toBe(false);
  });
});
