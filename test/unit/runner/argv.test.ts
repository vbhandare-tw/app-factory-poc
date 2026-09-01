/**
 * The CLI flags every run carries, and the ones no run may ever carry
 * (spec §4.2, §4.4; plan Section E item 6).
 *
 * Same caveat as `settings.test.ts`: this file restates a belief about the CLI's
 * interface. What makes the belief credible is that the exact argv shape below
 * was executed against real CLI v2.1.220 during Phase 5 and produced a fenced
 * run with validated structured output. See `test/integration/isolation.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_FLAGS,
  OUTPUT_FORMAT,
  REQUIRED_FLAGS,
  buildClaudeArgv,
} from '../../../src/runner/argv.js';
import { testProfile, testSpec } from '../../helpers/runnerFixtures.js';

const SETTINGS = '{"sandbox":{"enabled":true,"filesystem":{}}}';

/** Index of `flag`'s value, or undefined. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe('buildClaudeArgv', () => {
  it('always carries --safe-mode, --verbose, --output-format stream-json and --json-schema', () => {
    const argv = buildClaudeArgv(testSpec(), SETTINGS);

    // --safe-mode is the only thing that stops the operator's personal
    // ~/.claude/CLAUDE.md leaking into every agent (spec §4.2).
    expect(argv).toContain('--safe-mode');
    // --verbose is undocumented in --help and mandatory: without it
    // `--output-format stream-json` refuses to start (plan resolution A1).
    expect(argv).toContain('--verbose');
    expect(valueOf(argv, '--output-format')).toBe(OUTPUT_FORMAT);
    expect(valueOf(argv, '--output-format')).toBe('stream-json');
    expect(argv).toContain('--json-schema');
    expect(JSON.parse(valueOf(argv, '--json-schema') ?? 'null')).toEqual(testSpec().outputSchema);

    for (const flag of REQUIRED_FLAGS) {
      expect(argv, `required flag ${flag}`).toContain(flag);
    }
  });

  it('never carries --bare or any skip-permissions flag', () => {
    const argv = buildClaudeArgv(testSpec(), SETTINGS);

    // --bare forces ANTHROPIC_API_KEY/apiKeyHelper auth and never reads OAuth
    // or the keychain, so it breaks subscription auth (spec §4.2). It reads
    // like a stricter --safe-mode, which is why it needs an explicit test.
    expect(argv).not.toContain('--bare');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--allow-dangerously-skip-permissions');

    for (const flag of FORBIDDEN_FLAGS) {
      expect(argv, `forbidden flag ${flag}`).not.toContain(flag);
    }
    // Nothing that merely resembles them, either.
    expect(argv.filter((arg) => arg.includes('dangerously'))).toEqual([]);
    expect(argv.filter((arg) => arg === '--permission-mode')).toEqual([]);
  });

  it('reflects the profile budget in --max-budget-usd', () => {
    const argv = buildClaudeArgv(
      testSpec({ profile: testProfile({ maxBudgetUsd: 1.25 }) }),
      SETTINGS,
    );
    expect(valueOf(argv, '--max-budget-usd')).toBe('1.25');
  });

  it('passes exactly the profile tool list, and disables tools entirely for a no-tools role', () => {
    const withTools = buildClaudeArgv(
      testSpec({ profile: testProfile({ tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read'] }) }),
      SETTINGS,
    );
    expect(valueOf(withTools, '--tools')).toBe('Read,Grep,Glob');
    expect(valueOf(withTools, '--allowedTools')).toBe('Read');
    expect(valueOf(withTools, '--tools')).not.toContain('Bash');
    expect(valueOf(withTools, '--tools')).not.toContain('Write');

    // The PM has no tools at all (spec §4.3). Omitting the flag would hand it
    // the CLI's full default toolset.
    const pm = buildClaudeArgv(
      testSpec({ role: 'pm', profile: testProfile({ role: 'pm', cwd: 'scratch', tools: [], allowedTools: [] }) }),
      SETTINGS,
    );
    expect(pm).toContain('--tools');
    expect(valueOf(pm, '--tools')).toBe('');
    expect(pm).not.toContain('--allowedTools');
  });

  it('puts the prompt immediately after -p, ahead of the variadic tool flags', () => {
    // --tools/--allowedTools are declared `<tools...>`; commander keeps
    // consuming arguments until the next --flag, so a positional prompt placed
    // after them is swallowed into the tools list.
    const argv = buildClaudeArgv(testSpec({ prompt: 'refine the requirement' }), SETTINGS);
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('refine the requirement');
    expect(argv.indexOf('-p')).toBeLessThan(argv.indexOf('--tools'));
  });

  it('refuses to build a command with no schema or no settings', () => {
    expect(() =>
      buildClaudeArgv({ ...testSpec(), outputSchema: null as unknown as object }, SETTINGS),
    ).toThrow(/--json-schema/);
    expect(() => buildClaudeArgv(testSpec(), '')).toThrow(/no sandbox at all/);
    expect(() => buildClaudeArgv(testSpec({ model: '  ' }), SETTINGS)).toThrow(/no model/);
  });

  it('passes the settings JSON through byte-for-byte', () => {
    const argv = buildClaudeArgv(testSpec(), SETTINGS);
    expect(valueOf(argv, '--settings')).toBe(SETTINGS);
  });
});
