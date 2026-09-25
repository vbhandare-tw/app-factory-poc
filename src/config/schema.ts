/**
 * The `config.yml` schema (spec §11).
 *
 * Three properties this file exists to guarantee, none of which a hand-written
 * validator would give reliably:
 *
 * 1. **Every default is declared once, here.** A default duplicated between the
 *    template file and the loader drifts, and the drift is invisible until a
 *    vault created by an older `factory init` behaves differently from a new one.
 * 2. **Unknown keys are an error that names the key.** A typo like
 *    `max_paralell_devs: 4` under a permissive schema is silently ignored and
 *    the operator believes a setting took effect that never did.
 * 3. **Every problem is reported at once.** zod collects issues across all
 *    fields rather than throwing on the first, so a badly-hand-edited config
 *    produces one complete list instead of a fix-run-fix-run loop. Field-level
 *    `.refine()` (not object-level) is what preserves that: an object-level
 *    refinement only runs once every field already parsed, so it would hide
 *    itself behind any other error.
 */
import { z } from 'zod';

import { ROLES } from '../domain/roles.js';
import type { GateName } from '../domain/states.js';

/** The vault layout version this build understands (spec §11.1). */
export const SUPPORTED_VAULT_VERSION = 1;

/**
 * M1–M3 runs one Developer at a time. This is not a tuning knob that happens to
 * be set low — the claim/lock machinery is built and tested but the scheduler's
 * ranking rules 2–4 are M4, so a value above 1 would dispatch work in an order
 * nothing has verified.
 */
export const MAX_PARALLEL_DEVS_MESSAGE =
  'max_parallel_devs must be 1 in M1–M3. Parallel development is M4: the item claim exists ' +
  'but the scheduler ranking rules that make concurrent dispatch safe (requirements §8.1 ' +
  'rules 2–4 and the starvation guard) are not implemented yet.';

const positiveInt = (): z.ZodNumber => z.number().int().positive();

/**
 * A model alias (`sonnet`, `opus`, `haiku`) or a full model ID. Deliberately not
 * an enum: pinning to a full model ID is a supported and sometimes necessary
 * choice, and an enum here would make it a config error.
 */
const modelRef = z.string().min(1);

const modelsShape = {
  default: modelRef.default('sonnet'),
  ...Object.fromEntries(ROLES.map((role) => [role, modelRef.default('sonnet')])),
} as {
  default: z.ZodDefault<z.ZodString>;
} & Record<(typeof ROLES)[number], z.ZodDefault<z.ZodString>>;

export const ModelsSchema = z.strictObject(modelsShape).prefault({});

export const HumanCheckpointsSchema = z
  .strictObject({
    after_pm_refinement: z.boolean().default(true),
    after_ticket_breakdown: z.boolean().default(true),
    final_acceptance: z.boolean().default(true),
  })
  .prefault({});

export const GatesSchema = z
  .strictObject({
    tests: z.string().min(1).default('npm test'),
    lint: z.string().min(1).default('npm run lint'),
    build: z.string().min(1).default('npm run build'),
  })
  .prefault({});

export const ConfigSchema = z.strictObject({
  /** The only key with no default: a vault that is not bound to a repo is useless. */
  target_repo: z.string().min(1),
  vault_version: z.number().int().positive().default(SUPPORTED_VAULT_VERSION),
  base_branch: z.string().min(1).default('main'),
  runner: z.enum(['claude-code', 'mock', 'demo']).default('claude-code'),

  models: ModelsSchema,

  poll_interval: positiveInt().default(15),
  max_parallel_devs: positiveInt()
    .default(1)
    .refine((value) => value === 1, { message: MAX_PARALLEL_DEVS_MESSAGE }),
  max_parallel_other: positiveInt().default(1),
  agent_timeout: positiveInt().default(1800),
  lock_ttl: positiveInt().default(5400),
  max_attempts: positiveInt().default(3),
  context_warn_chars: positiveInt().default(200_000),
  gate_output_chars: positiveInt().default(20_000),
  /**
   * Warn when an agent's structured payload gets this big (plan Phase 7b).
   *
   * ============================================================================
   * WHAT THIS IS, AND — IMPORTANTLY — WHAT IT IS NOT
   * ============================================================================
   * Phase 6 measured a 15,370-character Delivery Lead payload against the
   * model's 128,000-token output ceiling, got 4.9%, and concluded there was a
   * ~20× margin. That measured the wrong limit: the binding constraint is the
   * CLI's own `StructuredOutput` delivery, which fails far below the model
   * ceiling and reports `terminalReason: "structured_output_retry_exhausted"`.
   *
   * **This key is not a failure predictor, and it must not be described as one.**
   * An earlier version of this comment claimed 15,000 was "deliberately below
   * the smallest payload observed to fail". Measuring the argument the model
   * actually sent on every rejected call across six recorded runs shows that was
   * false, and not marginally:
   *
   *     smallest REJECTED call:   2,145 characters
   *     largest  ACCEPTED call:  14,471 characters
   *
   * Rejections and acceptances overlap completely. The real fault is a
   * parameter-boundary parsing bug — the rejected calls carry the tickets array
   * glued onto the end of the previous string field, so the CLI reports
   * `root: must have required property 'tickets'` for a payload that did contain
   * them. No length threshold can see that coming.
   *
   * What size *does* correlate with is **frequency**. Before the Phase 7b trim
   * the DL averaged ~18,700 characters and delivery failed often; after it,
   * ~12,700, and the failures became less frequent without disappearing. So this
   * is a drift indicator — "the payload is back in the band where deliveries
   * have failed" — and 13,000 sits just under the 13,113 of the smallest
   * *repeatedly*-rejected call. Expect it to fire on a normal busy run; that is
   * the intent, and it is why it is a log line and never a refusal.
   *
   * **Two measurement limits, stated where they will be read.** It is evaluated
   * only after a payload has been accepted, so it never sees the deliveries that
   * failed — the ones you would most want measured. And it measures with compact
   * `JSON.stringify`, while the mangled emissions are pretty-printed, so it
   * understates what the CLI actually carried.
   */
  payload_warn_chars: positiveInt().default(13_000),

  run_budget: z.number().positive().nullable().default(null),
  max_budget_usd_per_run: z.number().positive().default(5),

  /**
   * Escape hatches, empty by default (plan resolution A2).
   *
   * Spec §11's example YAML seeds these with `~/.npm` and `~/.npmrc`. That
   * example predates the A2 probe, which ran `npm test` cleanly under
   * `denyRead: ["~/"]` with no extra reads allowed at all. Shipping the example's
   * values would punch two permanent holes in every agent's read fence to solve
   * a problem that does not exist.
   */
  sandbox_extra_read: z.array(z.string().min(1)).default([]),
  sandbox_extra_write: z.array(z.string().min(1)).default([]),

  /**
   * Worktree provisioning (plan resolution A3). A fresh `git worktree` has no
   * `node_modules` — it is untracked — and a sandboxed agent has no network, so
   * the orchestrator installs dependencies before the agent ever starts.
   */
  setup_command: z.string().min(1).default('npm ci'),
  setup_timeout: positiveInt().default(300),

  human_checkpoints: HumanCheckpointsSchema,
  gates: GatesSchema,
});

export type FactoryConfig = z.infer<typeof ConfigSchema>;

/**
 * Compile-time proof that the `gates` block names exactly the gates the domain
 * layer knows about. Adding a gate to `GATE_NAMES` without adding it here (or
 * the reverse) is a build failure rather than a gate that silently never runs.
 */
type _GatesMatchDomain = [
  Exclude<keyof FactoryConfig['gates'], GateName>,
  Exclude<GateName, keyof FactoryConfig['gates']>,
] extends [never, never]
  ? true
  : never;
const _gatesMatchDomain: _GatesMatchDomain = true;
void _gatesMatchDomain;
