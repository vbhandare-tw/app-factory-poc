/**
 * `--tools ""` against the real CLI — the Phase 5 debt Phase 6 closes.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * The `pm` profile is the first role with **no tools at all** (spec §4.3: "pure
 * text in, structured text out"). `buildClaudeArgv` emits `--tools ""` for it,
 * on the reasoning that omitting the flag entirely would hand the PM the CLI's
 * full default toolset.
 *
 * Until this test, that was asserted only in unit tests and against a stub
 * `claude` — and a stub accepts any flag you like. Three outcomes were possible
 * and they are not equally survivable: the CLI could accept it (what we want),
 * ignore it (the PM silently gets every tool), or error (every PM run fails).
 * Only a real run distinguishes them.
 *
 * ============================================================================
 * WHAT IT CHECKS, AND HOW IT KNOWS
 * ============================================================================
 * The CLI's own `system/init` event lists the tools the run was given, and every
 * tool call appears as a `tool_use` in the stream. Both are read from the
 * transcript rather than from the model's word for it — a model asked "do you
 * have tools?" is not evidence.
 *
 * The **negative control is free**: `test/fixtures/runner/real-run-2026-09-01.jsonl`
 * is a recorded real run made *with* `--tools Bash`, and the same two detectors
 * fire on it. Without that, "no tools were reported" could just mean the
 * detectors do not work.
 *
 * ============================================================================
 * HOW TO RUN IT
 * ============================================================================
 *   npm run test:all             # FACTORY_REAL_CLI=1 vitest run
 *   FACTORY_REAL_CLI=1 npx vitest run test/integration/agents-real-cli.test.ts
 *
 * Without `FACTORY_REAL_CLI=1` or `CI` the paid case reports SKIPPED and the
 * free cases still run.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { PROFILES, profileFor } from '../../src/agents/profiles.js';
import { loadSystemPrompt } from '../../src/agents/registry.js';
import { jsonSchemaFor, validateAgentOutput } from '../../src/agents/schemas.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { buildClaudeArgv } from '../../src/runner/argv.js';
import { ClaudeCodeRunner } from '../../src/runner/claudeCode.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { REAL_STREAM_FIXTURE, testSandboxConfig, testSpec } from '../helpers/runnerFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../helpers/toyRepo.js';
import { PROBED_CLI_VERSION, installedCliVersion } from '../helpers/cliVersion.js';

/*
 * The CLI version pin lives in `test/helpers/cliVersion.ts`, shared with
 * `isolation.test.ts` and `dev-loop-real-cli.test.ts`. It is asserted here for
 * its own reason: an upgrade that changes how `--tools ""` is read must fail
 * loudly, because the failure mode is a PM agent quietly holding the full
 * default toolset.
 */

/** Cheapest model that still runs the tool loop. Same one the isolation probe uses. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

const RUN_REAL_CLI =
  process.env['FACTORY_REAL_CLI'] === '1' ||
  (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== '0');

afterAll(() => {
  cleanupAllScratchDirs();
});

/**
 * The CLI's own structured-output mechanism, which arrives as a tool.
 *
 * This is a finding, not a detail: `--tools ""` leaves `StructuredOutput` in
 * place, and the payload comes back as a `tool_use` call on it. So "no tools"
 * means no tools the *model* can choose to use — the contract itself survives.
 * If a future CLI version strips this one too, the pm role loses its output
 * contract entirely and this test is what says so.
 */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

interface StreamFacts {
  /** The `tools` array from the `system/init` event, or `null` if there was none. */
  readonly initTools: string[] | null;
  /** Names of every tool actually called, in order, duplicates included. */
  readonly toolsUsed: string[];
  readonly lines: number;
}

function streamFacts(jsonl: string): StreamFacts {
  const lines = jsonl.split('\n').filter((line) => line.trim() !== '');
  let initTools: string[] | null = null;
  const toolsUsed: string[] = [];

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = event as {
      type?: string;
      subtype?: string;
      tools?: unknown;
      message?: { content?: unknown };
    };

    if (record.type === 'system' && record.subtype === 'init' && Array.isArray(record.tools)) {
      initTools = record.tools.map(String);
    }

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const part = block as { type?: string; name?: unknown };
      if (part.type === 'tool_use') toolsUsed.push(String(part.name ?? 'unnamed'));
    }
  }

  return { initTools, toolsUsed, lines: lines.length };
}

describe('--tools "" — free checks (always run)', () => {
  it('the pm profile really does produce an empty --tools argument', () => {
    const argv = buildClaudeArgv(
      testSpec({ role: 'pm', profile: PROFILES.pm, outputSchema: jsonSchemaFor('pm') }),
      '{"sandbox":{"enabled":true}}',
    );
    const index = argv.indexOf('--tools');
    expect(index, '--tools is missing entirely, which hands the PM every default tool').toBeGreaterThan(
      -1,
    );
    expect(argv[index + 1]).toBe('');
    expect(argv).not.toContain('--allowedTools');
  });

  it('the detectors fire on a recorded real run that DID have tools', () => {
    // The negative control, at zero cost. This fixture was recorded from a real
    // v2.1.220 run with `--tools Bash`. If these two signals could not tell a
    // tools-enabled run apart, the paid assertion below would be vacuous.
    const facts = streamFacts(readFileSync(REAL_STREAM_FIXTURE, 'utf8'));
    expect(facts.initTools, 'the init event carries no tools array').not.toBeNull();
    expect(facts.initTools, 'a run made with --tools Bash did not report Bash').toContain('Bash');
    expect(
      facts.toolsUsed.filter((tool) => tool !== STRUCTURED_OUTPUT_TOOL),
      'a run that used Bash shows no model-driven tool call',
    ).not.toEqual([]);
  });

  it('the installed CLI is the version this expectation was probed against', () => {
    const version = installedCliVersion();
    expect(
      version,
      `Claude Code reports "${version}" but the --tools "" behaviour recorded here was probed ` +
        `against ${PROBED_CLI_VERSION}. A change in how an empty tools list is read is a silent ` +
        'privilege escalation for the pm role.',
    ).toContain(PROBED_CLI_VERSION);
  });
});

describe.skipIf(!RUN_REAL_CLI)('--tools "" — real CLI (FACTORY_REAL_CLI=1 or CI)', () => {
  it('a no-tools role really gets no tools, and still returns structured output', async () => {
    const cwd = scratchDir('pm-probe-');
    const vault = new VaultPaths(scratchDir('pm-probe-vault-'));
    const events = new MemoryEventLog();

    const runner = new ClaudeCodeRunner({ config: testSandboxConfig(), events });

    const profile = profileFor('pm', { agent_timeout: 180, max_budget_usd_per_run: 0.5 });
    const spec = testSpec({
      role: 'pm',
      cwd,
      model: PROBE_MODEL,
      profile,
      outputSchema: jsonSchemaFor('pm'),
      systemPromptAppend: await loadSystemPrompt('pm'),
      // Deliberately asks for a tool. If `--tools ""` is ignored, the model has
      // Bash and the transcript will show it using it.
      prompt:
        'Requirement: "add a subtract operation to the calculator". Refine it. ' +
        'First, if you have a Bash tool, use it to run `echo TOOLS_ARE_AVAILABLE`. ' +
        'If you have no tools at all, skip that and say so in notes_markdown.',
      itemId: 'FEAT-PROBE',
      featureSlug: 'probe',
      attempt: 1,
      transcriptPath: vault.logPath('probe', 'FEAT-PROBE', 1, 'pm'),
      validateStructured: (value) => validateAgentOutput('pm', value),
    });

    const result = await runner.run(spec, new AbortController().signal);
    const facts = streamFacts(readFileSync(spec.transcriptPath, 'utf8'));

    // Printed on every run, so the finding is in the record rather than in a
    // reviewer's memory.
    console.log(
      `[tools-empty] cli=${installedCliVersion()} model=${PROBE_MODEL} ok=${result.ok} ` +
        `failure=${result.failure ?? 'none'} total_cost_usd=${result.costUsd} turns=${result.numTurns} ` +
        `terminal=${result.terminalReason}`,
    );
    console.log(
      `[tools-empty] init tools=${JSON.stringify(facts.initTools)} ` +
        `tools used=${JSON.stringify(facts.toolsUsed)} stream lines=${facts.lines}`,
    );

    // 1. The CLI accepted the flag: it did not fail to start.
    expect(
      result.failure,
      `the run failed (${result.terminalReason}) — if the CLI rejects an empty --tools, every ` +
        'pm run fails and the profile needs a different way to express "no tools"',
    ).toBeUndefined();

    // 2. No tool the model could choose was available, and none was used. The
    //    prompt explicitly asked it to run a Bash command, so a CLI that
    //    ignored the empty list would show `Bash` in both of these.
    expect(facts.initTools, 'the init event listed no tools array at all').not.toBeNull();
    expect(
      facts.initTools?.filter((tool) => tool !== STRUCTURED_OUTPUT_TOOL),
      'the empty --tools was ignored: the pm run was given tools',
    ).toEqual([]);
    expect(
      facts.toolsUsed.filter((tool) => tool !== STRUCTURED_OUTPUT_TOOL),
      'a no-tools run called a tool',
    ).toEqual([]);
    // ...and the one tool that remains is the contract itself, not a capability.
    expect(facts.toolsUsed, 'the structured payload did not come back as a tool call').toContain(
      STRUCTURED_OUTPUT_TOOL,
    );

    // 3. And the contract still works with no tools in play — the whole point of
    //    the role is structured text out.
    expect(result.ok, 'the pm run produced no valid structured output').toBe(true);
    expect(validateAgentOutput('pm', result.structured)).toEqual({ ok: true });
    expect(events.ofType('run_finished')[0]?.ok).toBe(true);
  }, 300_000);
});
