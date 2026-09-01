/**
 * One lookup binding everything a role needs (plan Phase 6).
 *
 * Profile, output schema, context recipe and system prompt are four separate
 * decisions about the same role, kept in four files because they change for
 * different reasons. `AGENTS` is where they meet, so the orchestrator's dispatch
 * (Phase 7a) reads one entry rather than four.
 *
 * The prompt is the one part that lives on disk rather than in code, which makes
 * it the one part that can go missing. `missingPromptFiles` exists so a missing
 * prompt fails `validateStartup` — before a worktree is cut or a run is paid for
 * — rather than throwing halfway through a cycle.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Role } from '../domain/roles.js';
import { ROLES } from '../domain/roles.js';
import type { AgentProfile } from '../runner/types.js';
import type { ContextRecipe } from './context.js';
import { RECIPES } from './context.js';
import { PROFILES } from './profiles.js';
import { AGENT_JSON_SCHEMAS, AGENT_SCHEMAS } from './schemas.js';

/**
 * `<project root>/prompts`.
 *
 * Resolved from this module rather than from `process.cwd()`, which is whatever
 * directory the operator ran `factory` in. Both `src/agents/` and `dist/agents/`
 * are one level under the project root, so the same two `..` steps work for the
 * TypeScript sources and for the build output.
 */
export const PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prompts',
);

export interface AgentDefinition {
  readonly role: Role;
  /** The role's own ceilings. Use `profileFor(role, config)` for a real run. */
  readonly profile: AgentProfile;
  readonly schema: (typeof AGENT_SCHEMAS)[Role];
  /** Handed to `--json-schema`. */
  readonly jsonSchema: object;
  readonly recipe: ContextRecipe;
  /** Absolute path to the system prompt appended with `--append-system-prompt`. */
  readonly promptFile: string;
}

export function promptPath(role: Role): string {
  return path.join(PROMPTS_DIR, `${role}.md`);
}

export const AGENTS: Readonly<Record<Role, AgentDefinition>> = Object.freeze(
  Object.fromEntries(
    ROLES.map((role) => [
      role,
      Object.freeze({
        role,
        profile: PROFILES[role],
        schema: AGENT_SCHEMAS[role],
        jsonSchema: AGENT_JSON_SCHEMAS[role],
        recipe: RECIPES[role],
        promptFile: promptPath(role),
      }),
    ]),
  ) as Record<Role, AgentDefinition>,
);

export function agentFor(role: Role): AgentDefinition {
  return AGENTS[role];
}

export class MissingPromptError extends Error {
  readonly role: Role;

  constructor(role: Role, file: string) {
    super(
      `no system prompt for role ${role} at ${file}. The prompt is the role's actual behaviour ` +
        '(plan Phase 6) — running without it would produce an agent with a schema and no job.',
    );
    this.name = 'MissingPromptError';
    this.role = role;
  }
}

/** Roles whose prompt file is not on disk. Empty in a healthy checkout. */
export function missingPromptFiles(): Role[] {
  return ROLES.filter((role) => !existsSync(promptPath(role)));
}

/**
 * Markdown files in `prompts/` that no role claims.
 *
 * Not a startup failure — an operator may keep a README there — but the
 * integration test asserts the set is empty, because the likeliest cause is a
 * prompt written for a role that was renamed, still on disk and never loaded.
 */
export function unknownPromptFiles(): string[] {
  const known = new Set(ROLES.map((role) => `${role}.md`));
  try {
    return readdirSync(PROMPTS_DIR)
      .filter((name) => name.endsWith('.md') && !known.has(name))
      .sort();
  } catch {
    return [];
  }
}

/** Read one system prompt. Throws `MissingPromptError` rather than an ENOENT. */
export async function loadSystemPrompt(role: Role): Promise<string> {
  const file = promptPath(role);
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      throw new MissingPromptError(role, file);
    }
    throw error;
  }
}
