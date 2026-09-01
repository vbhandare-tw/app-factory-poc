/**
 * The attempt policy — what a failed run costs the item (spec §9.1, plan 7b).
 *
 * Phase 7a kept this inline in `dispatch.ts` and charged every schema failure,
 * which is spec §9.1 as written. It is written out here because Phase 7b adds a
 * second forgiveness rule, Phase 9 adds gate failures and the `max_attempts`
 * off-by-one, and three separate policies interleaved with the note-writing
 * code is how one of them quietly stops applying.
 *
 * ============================================================================
 * WHY A FIRST SCHEMA FAILURE IS FREE
 * ============================================================================
 * A schema failure is not the same kind of event as a timeout or a crash. The
 * agent did the work; it returned the work in the wrong shape. Empirically that
 * is a near miss — one field misnamed, one array returned as a string, one
 * cross-field rule the CLI's own validator cannot express because `.refine()`
 * does not survive JSON Schema conversion (see `src/agents/schemas.ts`).
 *
 * Charged as a full attempt, a near-miss output contract eats a ticket's entire
 * budget three runs at a time: three malformed payloads and the item is in
 * `needs_human` having never once been told what was wrong with them. The agent
 * is never shown the validator's complaint, because a fresh dispatch builds a
 * fresh context from the vault and the malformed payload was never written.
 *
 * So the first schema failure in a dispatch buys a **re-run with the validation
 * error injected into the prompt**, and costs nothing. Only if that re-run also
 * fails validation does the attempt get charged — the agent has now been told
 * precisely what the contract wants and still missed it, which is the failure
 * spec §9.1 means.
 *
 * ============================================================================
 * WHAT THIS COSTS, STATED PLAINLY
 * ============================================================================
 * The forgiveness is per **dispatch**, not per item lifetime, because holding
 * it across cycles would need a new frontmatter field and a rule about when it
 * resets — and "consecutive" is only meaningful inside one uninterrupted
 * sequence of runs anyway. The consequence is a hard 2× bound on runs: an item
 * whose role is systematically unable to satisfy its schema burns
 * `2 × max_attempts` runs instead of `max_attempts` before it parks. At the
 * Phase 6 measured rate that is at worst ~$3.70 for a `tl_plan` at
 * `max_attempts: 3`, and it buys the case this rule exists for — where run two
 * succeeds because run one was told what was wrong.
 */
import type { Role } from '../domain/roles.js';
import type { PauseReason } from '../domain/states.js';
import type { AgentFailure } from '../runner/types.js';

/** How many schema failures one dispatch forgives before charging. */
export const FREE_SCHEMA_RETRIES = 1;

/**
 * What the orchestrator does about a failed run.
 *
 * `retry_in_place` is the only one that runs the agent again inside the same
 * dispatch. `forgive` leaves the item where it is for the next cycle to pick
 * up; `consume` charges the attempt.
 */
export type FailureDisposition =
  | {
      readonly kind: 'retry_in_place';
      /** Injected into the retry's prompt. Carries the validator's own words. */
      readonly guidance: string;
      readonly reason: string;
    }
  | { readonly kind: 'forgive'; readonly reason: string }
  | { readonly kind: 'consume' };

export interface FailureContext {
  readonly failure: AgentFailure;
  readonly role: Role;
  /**
   * Schema failures already forgiven **in this dispatch**. Zero on the first
   * run of an attempt.
   */
  readonly schemaFailuresForgiven: number;
  /** The validator's issues, when `failure` is `'schema'`. */
  readonly issues?: readonly string[] | undefined;
}

/**
 * The one place that decides what a failure costs.
 *
 * **`'aborted'` is forgiven** — a Phase 7a decision (spec §8.1's Phase 5 note
 * hands the question to the orchestrator explicitly). `'timeout'` means the
 * agent ran past `config.agent_timeout`, which is the agent's failure and which
 * spec §9.1 rightly charges. `'aborted'` means *we* cancelled: a `factory
 * stop`, an operator's Ctrl-C, a drain. The agent did nothing wrong and may
 * have been seconds from finishing. Charging it would mean three orchestrator
 * restarts during one ticket park it in `needs_human` for reasons that have
 * nothing to do with the work.
 *
 * Nothing is less safe for forgiving it: `ok` is `false` either way, so a
 * cancelled run advances nothing and writes nothing. The only risk is an abort
 * that repeats forever, and that is a stuck orchestrator — which burning
 * attempts would hide rather than fix.
 */
export function classifyFailure(context: FailureContext): FailureDisposition {
  if (context.failure === 'aborted') {
    return {
      kind: 'forgive',
      reason: 'the orchestrator cancelled the run, so the agent did not fail',
    };
  }

  if (context.failure === 'schema' && context.schemaFailuresForgiven < FREE_SCHEMA_RETRIES) {
    return {
      kind: 'retry_in_place',
      guidance: schemaRetryGuidance(context.role, context.issues ?? []),
      reason:
        "the payload missed its output contract and the agent was never shown the validator's " +
        'complaint — re-running with it costs one run and often fixes the shape',
    };
  }

  return { kind: 'consume' };
}

/**
 * Phase 7a's predicate, kept because `pipeline-paper.test.ts` asserts on it and
 * because "does this cost an attempt" is a question worth being able to ask
 * without a whole `FailureContext`.
 *
 * Deliberately narrower than `classifyFailure`: it cannot see the retry rule,
 * because a `retry_in_place` neither consumes nor finally forgives — it defers.
 * Callers deciding what to *write* must use `classifyFailure`.
 */
export function failureConsumesAttempt(failure: AgentFailure): boolean {
  return failure !== 'aborted';
}

/** Which `pause_reason` an exhausted item records (spec §5 rule 4, §9.1). */
export function pauseReasonForFailure(failure: AgentFailure): PauseReason {
  switch (failure) {
    case 'schema':
      return 'malformed_output';
    case 'timeout':
      return 'timeout';
    case 'aborted':
    case 'crash':
    case 'api_error':
      return 'attempts_exhausted';
    default: {
      const unreachable: never = failure;
      throw new Error(`no pause reason for failure ${String(unreachable)}`);
    }
  }
}

/**
 * The text the retry run is given, on top of its normal context.
 *
 * Three things it has to do, and each one is there because of a way a retry
 * goes wrong:
 *
 * 1. **Quote the validator verbatim.** A paraphrase ("the output was invalid")
 *    is worth nothing — the agent already believes its output was valid, so the
 *    only new information is the specific complaint.
 * 2. **Say that nothing was recorded.** Otherwise the agent treats this as a
 *    follow-up turn and returns a patch — a payload containing only the fields
 *    it thinks it got wrong, which fails validation for a second, different
 *    reason.
 * 3. **Forbid narrating the retry.** `notes_markdown` is appended verbatim to a
 *    note a human reads; "as noted above, I have corrected the schema issue" is
 *    the orchestrator's plumbing leaking into the product record.
 */
export function schemaRetryGuidance(role: Role, issues: readonly string[]): string {
  const list =
    issues.length === 0
      ? '- (the validator reported no detail — check every required field and its type)'
      : issues.map((issue) => `- ${issue}`).join('\n');

  return [
    'IMPORTANT — your previous response for this exact task was rejected before it reached the',
    `vault. It did not satisfy the \`${role}\` output contract, so **nothing you returned was`,
    'recorded** and nothing downstream saw it. This is a re-run of the same task, not a',
    'follow-up turn.',
    '',
    'The validator reported:',
    '',
    list,
    '',
    'Return the **whole payload again**, complete and self-contained, with those problems fixed.',
    'A partial payload carrying only the corrected fields fails validation for a second reason.',
    'Do not mention this rejection in any field — the fields are the work product, and',
    '`notes_markdown` is appended verbatim to a note a human reads.',
  ].join('\n');
}
