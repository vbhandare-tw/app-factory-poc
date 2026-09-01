/**
 * The `claude` command line (spec §4.4, verified against CLI v2.1.220).
 *
 * Kept as a pure function in its own module so `test/unit/runner/argv.test.ts`
 * can assert the exact flag list without importing `node:child_process` or
 * spawning anything.
 *
 * Three flags are load-bearing and none of them is obvious:
 *
 * - `--safe-mode` is the *only* thing that stops a headless run inheriting the
 *   operator's `~/.claude/CLAUDE.md` (spec §4.2 — `--setting-sources ""` and
 *   `--system-prompt` both fail to). Plan Section E item 6 forbids dropping it.
 * - `--verbose` is undocumented in `--help` but mandatory: without it
 *   `--output-format stream-json` exits with
 *   `Error: When using --print, --output-format=stream-json requires --verbose`
 *   (plan resolution A1).
 * - `--bare` must never appear. It forces `ANTHROPIC_API_KEY`/`apiKeyHelper`
 *   auth and never reads OAuth or the keychain, so it breaks subscription auth
 *   (spec §4.2). It is tempting because its description reads like a stricter
 *   `--safe-mode`.
 */
import type { AgentRunSpec } from './types.js';

/**
 * Flags that must never appear, checked by `test/unit/runner/argv.test.ts`.
 *
 * `--allow-dangerously-skip-permissions` is included as well as the more
 * famous `--dangerously-skip-permissions`: it merely *enables* the bypass
 * rather than turning it on, which makes it look harmless and is not.
 */
export const FORBIDDEN_FLAGS = [
  '--bare',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
] as const;

/** Flags that must always appear, in every run, for every role. */
export const REQUIRED_FLAGS = [
  '--safe-mode',
  '--verbose',
  '--output-format',
  '--json-schema',
  '--settings',
] as const;

export const OUTPUT_FORMAT = 'stream-json';

/**
 * Build the argument vector for one run.
 *
 * The prompt sits immediately after `-p` on purpose. `--tools` and
 * `--allowedTools` are declared variadic (`<tools...>`) in the CLI, so commander
 * keeps consuming arguments until the next `--flag`; a positional prompt placed
 * after them would be swallowed into the tools list. Verified empirically.
 */
export function buildClaudeArgv(spec: AgentRunSpec, settingsJson: string): string[] {
  if (spec.model.trim().length === 0) {
    throw new Error(`buildClaudeArgv: run ${spec.runId} has no model`);
  }
  if (spec.outputSchema === null || typeof spec.outputSchema !== 'object') {
    throw new Error(
      `buildClaudeArgv: run ${spec.runId} has no output schema. Every run is contract-bound ` +
        '(spec §5) — refusing to invoke the CLI without --json-schema.',
    );
  }
  if (settingsJson.trim().length === 0) {
    throw new Error(
      `buildClaudeArgv: run ${spec.runId} has empty --settings. That would run the agent with ` +
        'no sandbox at all (plan Section E item 6).',
    );
  }

  const argv: string[] = [
    '-p',
    spec.prompt,
    '--model',
    spec.model,
    '--safe-mode',
    '--verbose',
    '--output-format',
    OUTPUT_FORMAT,
    '--json-schema',
    JSON.stringify(spec.outputSchema),
  ];

  if (spec.systemPromptAppend.length > 0) {
    argv.push('--append-system-prompt', spec.systemPromptAppend);
  }

  if (spec.profile.tools.length > 0) {
    argv.push('--tools', spec.profile.tools.join(','));
  } else {
    // `--tools ""` is the CLI's documented way to disable every tool. Omitting
    // the flag would hand a no-tools role (the PM) the full default toolset.
    argv.push('--tools', '');
  }

  if (spec.profile.allowedTools.length > 0) {
    argv.push('--allowedTools', spec.profile.allowedTools.join(','));
  }

  argv.push('--settings', settingsJson);
  argv.push('--max-budget-usd', String(spec.profile.maxBudgetUsd));

  return argv;
}
