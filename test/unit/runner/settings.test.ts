/**
 * The sandbox JSON — plan Phase 5's highest-severity quiet failure.
 *
 * READ THIS BEFORE TRUSTING THIS FILE.
 *
 * Not one test here proves the fence blocks anything. Every one of them
 * compares the object `buildSandboxSettings` built against the object this file
 * expects, which is the same author's belief about the syntax written down
 * twice. If the belief is wrong, both sides are wrong together and the suite is
 * green.
 *
 * What these tests are actually worth: they catch **drift**. Once
 * `test/integration/isolation.test.ts` has proved the current shape really does
 * produce `EPERM` against the real CLI, these tests freeze that shape so a later
 * phase cannot quietly change it (plan Section E items 6 and 8a).
 *
 * The proof lives in `test/integration/isolation.test.ts`. Nowhere else.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROLES } from '../../../src/domain/roles.js';
import {
  GIT_FENCE_DIRS,
  HOME_DENY_READ,
  SANDBOX_ENV_OVERRIDES,
  SandboxPathSyntaxError,
  assertStandardSandboxPath,
  buildSandboxSettings,
  gitFenceWritePaths,
  sandboxEnv,
} from '../../../src/runner/settings.js';
import { profileTouchesRepo } from '../../../src/runner/types.js';
import {
  PROFILE_CWD_BY_ROLE,
  testProfile,
  testSandboxConfig,
} from '../../helpers/runnerFixtures.js';

const REPO = '/Users/example/code/target-repo';
const WORKTREE = '/Users/example/code/.factory-worktrees/demo/FEAT-DEMO-T001';

describe('buildSandboxSettings — the fence', () => {
  it('the developer profile is sandboxed and can read its own worktree', () => {
    const settings = buildSandboxSettings(
      testProfile({ role: 'developer', cwd: 'ticket_worktree' }),
      WORKTREE,
      testSandboxConfig(),
      REPO,
    );

    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.allowRead).toContain(WORKTREE);
  });

  it('denies reading the home directory on every profile', () => {
    for (const role of ROLES) {
      const settings = buildSandboxSettings(
        testProfile({ role, cwd: PROFILE_CWD_BY_ROLE[role] }),
        WORKTREE,
        testSandboxConfig(),
        REPO,
      );
      expect(settings.sandbox.filesystem.denyRead, `role ${role}`).toEqual([HOME_DENY_READ]);
    }
  });

  it('uses standard path syntax throughout, never the // form permissions rules take', () => {
    // spec §4.2: `sandbox.filesystem.*` takes /abs, ~/ and bare-relative;
    // `permissions.*` takes //abs and /project-relative. A // entry here is
    // accepted as JSON, matches nothing, and leaves the agent unfenced.
    const settings = buildSandboxSettings(
      testProfile({ role: 'developer', cwd: 'ticket_worktree' }),
      WORKTREE,
      testSandboxConfig({ sandbox_extra_read: ['~/.cache/shared'] }),
      REPO,
    );

    const every = [
      ...settings.sandbox.filesystem.denyRead,
      ...settings.sandbox.filesystem.allowRead,
      ...settings.sandbox.filesystem.allowWrite,
      ...settings.sandbox.filesystem.denyWrite,
    ];
    expect(every.length).toBeGreaterThan(0);
    for (const entry of every) {
      expect(entry.startsWith('//'), `entry ${entry} uses the permissions // form`).toBe(false);
      expect(entry).toMatch(/^([~/]|[A-Za-z0-9._])/);
      expect(entry).not.toMatch(/^[A-Za-z][A-Za-z0-9_]*\(/);
    }
    expect(every).toContain('~/.cache/shared');
  });

  it('refuses a config entry written in permissions syntax rather than emitting a dead rule', () => {
    expect(() =>
      buildSandboxSettings(
        testProfile(),
        WORKTREE,
        testSandboxConfig({ sandbox_extra_read: ['//Users/example/secrets'] }),
        REPO,
      ),
    ).toThrow(SandboxPathSyntaxError);

    expect(() => assertStandardSandboxPath('Read(//abs/**)', 'allowRead')).toThrow(
      SandboxPathSyntaxError,
    );
    expect(() => assertStandardSandboxPath('/Users/example/ok', 'allowRead')).not.toThrow();
    expect(() => assertStandardSandboxPath('~/', 'denyRead')).not.toThrow();
  });

  it('merges sandbox_extra_read and sandbox_extra_write from config', () => {
    const settings = buildSandboxSettings(
      testProfile(),
      WORKTREE,
      testSandboxConfig({
        sandbox_extra_read: ['/opt/toolchain'],
        sandbox_extra_write: ['/var/cache/factory'],
      }),
      REPO,
    );

    expect(settings.sandbox.filesystem.allowRead).toContain('/opt/toolchain');
    expect(settings.sandbox.filesystem.allowWrite).toContain('/var/cache/factory');
  });

  it('fences .git/{hooks,config,refs,objects} on every repo-touching profile', () => {
    // Plan resolution A6 / ADR-003. A hook planted here later executes
    // UNSANDBOXED under the orchestrator; a writable refs/ moves main.
    const expected = [
      path.join(REPO, '.git', 'hooks'),
      path.join(REPO, '.git', 'config'),
      path.join(REPO, '.git', 'refs'),
      path.join(REPO, '.git', 'objects'),
    ];
    expect(gitFenceWritePaths(REPO)).toEqual(expected);
    expect([...GIT_FENCE_DIRS]).toEqual(['hooks', 'config', 'refs', 'objects']);

    for (const role of ROLES) {
      const profile = testProfile({ role, cwd: PROFILE_CWD_BY_ROLE[role] });
      if (!profileTouchesRepo(profile)) continue;
      const settings = buildSandboxSettings(profile, WORKTREE, testSandboxConfig(), REPO);
      for (const fenced of expected) {
        expect(settings.sandbox.filesystem.denyWrite, `role ${role}`).toContain(fenced);
      }
    }
  });

  it('refuses to build settings for a repo-touching profile with no repoRoot', () => {
    // Fail closed. The alternative — an empty denyWrite — produces a run that
    // works perfectly and has no .git fence.
    expect(() =>
      buildSandboxSettings(
        testProfile({ role: 'developer', cwd: 'ticket_worktree' }),
        WORKTREE,
        testSandboxConfig(),
      ),
    ).toThrow(/needs the \.git write fence/);
  });

  it('applies no .git fence to a scratch profile, which has no repo', () => {
    const settings = buildSandboxSettings(
      testProfile({ role: 'pm', cwd: 'scratch', tools: [], allowedTools: [] }),
      '/Users/example/scratch/pm-run',
      testSandboxConfig(),
    );
    expect(settings.sandbox.filesystem.denyWrite).toEqual([]);
    expect(settings.sandbox.filesystem.allowRead).toEqual(['/Users/example/scratch/pm-run']);
  });

  it('round-trips through JSON.stringify/parse unchanged', () => {
    const settings = buildSandboxSettings(
      testProfile(),
      WORKTREE,
      testSandboxConfig({ sandbox_extra_read: ['~/.cache/x'] }),
      REPO,
    );
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });

  it('puts the repo root on allowRead so git can read its own object store', () => {
    // A linked worktree's real .git lives at <repo>/.git/worktrees/<id>, outside
    // the worktree (spec §4.5). Under denyRead ["~/"] a repo under the home
    // directory would otherwise be unreadable and every git command would fail.
    const settings = buildSandboxSettings(testProfile(), WORKTREE, testSandboxConfig(), REPO);
    expect(settings.sandbox.filesystem.allowRead).toContain(REPO);
  });

  it('de-duplicates without losing the first occurrence', () => {
    const settings = buildSandboxSettings(
      testProfile({ allowRead: [WORKTREE, '/opt/x'] }),
      WORKTREE,
      testSandboxConfig({ sandbox_extra_read: ['/opt/x'] }),
      REPO,
    );
    const occurrences = settings.sandbox.filesystem.allowRead.filter((p) => p === '/opt/x');
    expect(occurrences).toHaveLength(1);
    expect(settings.sandbox.filesystem.allowRead[0]).toBe(WORKTREE);
  });
});

describe('sandboxEnv — keeping read-only git usable', () => {
  it('points git at an empty global config instead of the operator home', () => {
    // Verified during Phase 5: under denyRead ["~/"] every git command fails
    // with `fatal: unable to access '<home>/.gitconfig': Operation not
    // permitted`, exit 128 — before it ever reaches the .git fence. Spec §4.5
    // claims git status/diff keep working; they do not without this.
    expect(SANDBOX_ENV_OVERRIDES['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    // ...and the XDG fallback git uses for core.excludesFile when there is no
    // global config, which otherwise warns twice on every git command.
    expect(SANDBOX_ENV_OVERRIDES['XDG_CONFIG_HOME']).toBe('/dev/null');
    expect(sandboxEnv({ PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      XDG_CONFIG_HOME: '/dev/null',
    });
  });

  it('overrides an inherited GIT_CONFIG_GLOBAL rather than deferring to it', () => {
    expect(sandboxEnv({ GIT_CONFIG_GLOBAL: '/Users/example/.gitconfig' })['GIT_CONFIG_GLOBAL']).toBe(
      '/dev/null',
    );
  });
});
