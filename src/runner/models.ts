/**
 * Which model a role runs on (spec §11, plan resolution A7).
 *
 * Sonnet everywhere by default. The cost of a feature is dominated by run count
 * — 12+ runs, up to 3 attempts each — not by any single run's difficulty, so
 * promoting a role to Opus should be a deliberate decision backed by the
 * Phase 13 numbers rather than a default.
 */
import type { Role } from '../domain/roles.js';

/** The fallback of last resort, if `models.default` is somehow absent. */
export const DEFAULT_MODEL = 'sonnet';

/** Only the config keys this module reads. */
export interface ModelConfigView {
  readonly models: Readonly<Partial<Record<Role | 'default', string>>>;
}

/**
 * `config.models[role] ?? config.models.default`.
 *
 * The zod schema defaults every role to `sonnet`, so in practice the first
 * lookup always hits. The fallbacks exist for a hand-built config object in a
 * test and for a config written by an older `factory init`.
 */
export function resolveModel(role: Role, config: ModelConfigView): string {
  const perRole = config.models[role];
  if (typeof perRole === 'string' && perRole.length > 0) return perRole;

  const fallback = config.models.default;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;

  return DEFAULT_MODEL;
}
