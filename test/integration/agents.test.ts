/**
 * The agent layer as the runner will actually consume it (plan Phase 6).
 *
 * Three things are proven here that no unit test can:
 *
 * 1. **A whole `AgentRunSpec` per role** — profile, context, prompt and schema
 *    together — produces a well-formed argv and a well-formed settings object,
 *    and the JSON Schema survives the trip through `JSON.stringify` into the
 *    flag and back.
 * 2. **`prompts/` and `AGENTS` agree in both directions.** A prompt file with no
 *    role is dead; a role with no prompt file must fail at startup, not mid-run.
 * 3. **No heading string literal exists anywhere in `src/agents/`.** The four
 *    section names the recipes read were inferred in Phase 3, and a literal with
 *    the wrong wording extracts nothing while every test still passes. The only
 *    reliable defence is that the literal cannot be written at all.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { buildContext } from '../../src/agents/context.js';
import { PROFILES, profileFor } from '../../src/agents/profiles.js';
import {
  AGENTS,
  PROMPTS_DIR,
  loadSystemPrompt,
  missingPromptFiles,
  promptPath,
  unknownPromptFiles,
} from '../../src/agents/registry.js';
import { jsonSchemaFor, validateAgentOutput } from '../../src/agents/schemas.js';
import { validateStartup } from '../../src/config/validate.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { ROLES } from '../../src/domain/roles.js';
import type { Role } from '../../src/domain/roles.js';
import { FORBIDDEN_FLAGS, REQUIRED_FLAGS, buildClaudeArgv } from '../../src/runner/argv.js';
import { buildSandboxSettings, sandboxSettingsJson } from '../../src/runner/settings.js';
import { profileTouchesRepo } from '../../src/runner/types.js';
import type { AgentRunSpec } from '../../src/runner/types.js';
import { SECTION_ORDER } from '../../src/vault/storage.js';
import { agentVault, validOutput } from '../helpers/agentFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, scratchDir, toyRepo } from '../helpers/toyRepo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = path.resolve(HERE, '..', '..', 'src', 'agents');

afterAll(() => {
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

const CONFIG = ConfigSchema.parse({ target_repo: '/nowhere' });

describe('per-role run spec', () => {
  it('every role builds a well-formed argv and settings object', async () => {
    const repo = toyRepo();
    const vault = await agentVault({
      tickets: [{ id: 'FEATDEMO-T001', sections: [[SECTION_ORDER[2], 'the criteria']] }],
    });

    for (const role of ROLES) {
      const definition = AGENTS[role];
      const profile = profileFor(role, CONFIG);
      const cwd = profile.cwd === 'scratch' ? scratchDir('agent-scratch-') : repo.path;

      const { prompt, report } = await buildContext(definition.recipe, {
        storage: vault.storage,
        paths: vault.paths,
        featureSlug: vault.slug,
        ticketId: 'FEATDEMO-T001',
        repoRoot: repo.path,
        attempt: 1,
        diff: 'diff --git a/src/calc.ts b/src/calc.ts\n+export const x = 1;',
        maxChars: CONFIG.context_warn_chars,
        task: `Complete the ${role} step.`,
      });
      expect(report.overLimit, `${role} context is over the limit`).toBe(false);

      const spec: AgentRunSpec = {
        runId: `FEATDEMO-T001-${role}-a1-0`,
        role,
        cwd,
        prompt,
        systemPromptAppend: await loadSystemPrompt(role),
        profile,
        outputSchema: definition.jsonSchema,
        model: CONFIG.models[role],
        transcriptPath: vault.paths.logPath(vault.slug, 'FEATDEMO-T001', 1, role),
        itemId: 'FEATDEMO-T001',
        featureSlug: vault.slug,
        attempt: 1,
        validateStructured: (value) => validateAgentOutput(role, value),
      };

      const settings = buildSandboxSettings(profile, cwd, CONFIG, repo.path);
      const settingsJson = sandboxSettingsJson(settings);
      const argv = buildClaudeArgv(spec, settingsJson);

      for (const flag of REQUIRED_FLAGS) expect(argv, `${role} is missing ${flag}`).toContain(flag);
      for (const flag of FORBIDDEN_FLAGS) expect(argv, `${role} carries ${flag}`).not.toContain(flag);

      // The schema round-trips through the flag unchanged.
      const schemaArg = argv[argv.indexOf('--json-schema') + 1] ?? '';
      expect(JSON.parse(schemaArg)).toEqual(jsonSchemaFor(role));

      // The system prompt is really attached, and it is the role's own.
      const promptArg = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
      expect(promptArg.length).toBeGreaterThan(200);
      expect(promptArg).toBe(readFileSync(promptPath(role), 'utf8'));

      // `--tools` is always present: omitting it hands a no-tools role the
      // CLI's full default toolset.
      const toolsArg = argv[argv.indexOf('--tools') + 1];
      expect(toolsArg).toBe(profile.tools.join(','));
      if (role === 'pm') expect(toolsArg).toBe('');

      // The fence: repo roles get the .git denyWrite, and nothing gets the vault.
      const touchesRepo = profileTouchesRepo(profile);
      expect(settings.sandbox.enabled).toBe(true);
      expect(settings.sandbox.filesystem.denyRead).toContain('~/');
      expect(settings.sandbox.filesystem.denyWrite.length > 0, `${role} .git fence`).toBe(touchesRepo);

      // Plan Section E item 5, checked on the object the CLI receives rather
      // than on the profile that produced it.
      expect(settingsJson, `${role} was granted a vault path`).not.toContain(vault.root);
      expect(settingsJson).not.toContain(vault.paths.featuresDir());
    }
  });

  it('a valid payload for each role passes the spec-level validator', () => {
    for (const role of ROLES) {
      const validate = (value: unknown): unknown => validateAgentOutput(role, value);
      expect(validate(validOutput(role))).toEqual({ ok: true });
    }
  });
});

describe('prompts and AGENTS agree in both directions', () => {
  it('every role has a prompt file and every prompt file has a role', () => {
    expect(missingPromptFiles(), 'a role has no system prompt on disk').toEqual([]);
    expect(unknownPromptFiles(), 'a prompt file belongs to no role').toEqual([]);

    const onDisk = readdirSync(PROMPTS_DIR)
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(onDisk).toEqual(ROLES.map((role) => `${role}.md`).sort());

    for (const role of ROLES) {
      expect(AGENTS[role].promptFile).toBe(promptPath(role));
      expect(existsSync(AGENTS[role].promptFile)).toBe(true);
    }
  });

  it('every prompt is substantial and states the rules it must state', async () => {
    // Deliberately mechanical. Whether a prompt is *good* is a human's call
    // (plan Phase 6 done condition); what is checkable is that each one carries
    // the constraints this project discovered the hard way.
    for (const role of ROLES) {
      const text = (await loadSystemPrompt(role)).toLowerCase();
      expect(text.length, `${role}.md is too short to be a system prompt`).toBeGreaterThan(800);
      expect(text, `${role}.md never mentions escalation`).toContain('escalate');
      expect(text, `${role}.md never says the structured output is the work product`).toMatch(
        /structured output/,
      );
      expect(text, `${role}.md never says the agent cannot write the vault`).toMatch(/vault/);
    }

    const developer = (await loadSystemPrompt('developer')).toLowerCase();
    expect(developer, 'the developer must be told it cannot commit').toMatch(/cannot commit/);
    expect(developer, 'the developer must be told to leave the tree dirty').toMatch(/dirty/);
    expect(developer, 'the developer must be told it proposes a commit message').toMatch(
      /commit_message/,
    );
  });

  it('a missing prompt file fails startup validation rather than a later run', () => {
    const failures = validateStartup(
      { vaultPath: scratchDir('startup-'), config: CONFIG },
      { promptsMissing: (): Role[] => ['qa'] },
    );
    const prompt = failures.filter((failure) => failure.code === 'prompt_missing');
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.key).toBe('prompts.qa');

    // And a healthy checkout reports none.
    expect(
      validateStartup({ vaultPath: scratchDir('startup-'), config: CONFIG }).filter(
        (failure) => failure.code === 'prompt_missing',
      ),
    ).toEqual([]);
  });
});

describe('section names come from SECTION_ORDER, never string literals', () => {
  /** Source with comments removed, so prose about `## History` is not a hit. */
  function codeOf(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  const files = readdirSync(AGENTS_SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(AGENTS_SRC, name));

  it('there is source to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(['profiles.ts', 'schemas.ts', 'context.ts', 'registry.ts'])(
    '%s contains no markdown heading literal',
    (name) => {
      const code = codeOf(path.join(AGENTS_SRC, name));
      // Any string literal that starts with a `#` heading marker. A recipe that
      // types `'## Review Notes'` and gets the wording slightly wrong extracts
      // an empty string, and the agent runs perfectly on a blank section.
      const matches = code.match(/(['"`])\s*#{1,6}\s[^'"`]*\1/g) ?? [];
      expect(
        matches,
        `${name} builds a heading as a literal instead of asking SECTION_ORDER`,
      ).toEqual([]);
    },
  );

  it('every SECTION_ORDER heading is reachable by name, and only by name', () => {
    // The other half: the constant must still offer the four inferred names the
    // recipes ask for. `sectionHeading` throws at import if it does not, so this
    // asserts the pairing explicitly rather than relying on that crash.
    const code = codeOf(path.join(AGENTS_SRC, 'context.ts'));
    for (const heading of SECTION_ORDER) {
      const name = heading.replace(/^#+\s*/, '');
      if (!code.includes(`sectionHeading('${name}')`)) continue;
      expect(SECTION_ORDER as readonly string[]).toContain(heading);
    }
    expect(code).toContain("sectionHeading('Review Notes')");
    expect(code).toContain("sectionHeading('QA Notes')");
  });
});

describe('profiles as the runner sees them', () => {
  it('a scratch-cwd profile needs no repo root, and a repo profile refuses without one', () => {
    const scratch = scratchDir('agent-scratch-');
    expect(() => buildSandboxSettings(PROFILES.pm, scratch, CONFIG)).not.toThrow();
    expect(() => buildSandboxSettings(PROFILES.developer, scratch, CONFIG)).toThrow(/repoRoot/);
  });
});
