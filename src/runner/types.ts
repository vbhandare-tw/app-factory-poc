/**
 * The seam between the orchestrator and whatever actually runs an agent
 * (spec §8.1).
 *
 * Two implementations exist: `ClaudeCodeRunner`, which spawns the real CLI, and
 * `MockRunner`, which replays canned structured output. Every test above unit
 * level runs on the mock, so this interface is the thing that makes the whole
 * pipeline testable without spending money — keep it narrow and keep it free of
 * anything Claude-Code-specific.
 */
import type { Role } from '../domain/roles.js';

/**
 * Why a run did not produce usable output (spec §8.1, §9.1).
 *
 * There is deliberately no `'unknown'` member. Every path in the runner maps
 * onto one of these, so a new failure mode is a compile error rather than a
 * silently-successful run.
 *
 * **`'aborted'` is a deviation from spec §8.1**, which lists four kinds. It was
 * added in Phase 5 after `MockRunner` and `ClaudeCodeRunner` were found to
 * disagree about what an external `AbortSignal` means — the mock called it
 * `'timeout'`, the real runner called it `'crash'`, and since every test above
 * unit level in Phases 7–11 runs on the mock, that disagreement would have been
 * invisible until a real run in Phase 12.
 *
 * Collapsing the two into either existing kind would have been the smaller
 * change. It was rejected because it destroys information the orchestrator
 * needs and cannot recover later:
 *
 * - `'timeout'` means **the agent took too long** — `config.agent_timeout`
 *   elapsed. That is the agent's failure, and spec §9.1 rightly counts it as a
 *   failed attempt.
 * - `'aborted'` means **the orchestrator cancelled** — a shutdown, a drain, an
 *   operator action. The agent did nothing wrong and may have been seconds from
 *   finishing.
 *
 * If both report as `'timeout'`, three orchestrator restarts during one ticket
 * exhaust its `max_attempts` and park it in `needs_human` for reasons that have
 * nothing to do with the agent. Phase 7a must be free to decide that an
 * orchestrator-initiated cancel does not burn an attempt; it cannot decide that
 * if the runner has already thrown the distinction away.
 *
 * Nothing is less safe for the extra member: `ok` is `false` either way, so no
 * cancelled run can advance a ticket. Spec §9.1's table treats it exactly like
 * a crash until Phase 7a says otherwise.
 */
export type AgentFailure = 'timeout' | 'aborted' | 'crash' | 'schema' | 'api_error';

/**
 * Where a role works (spec §4.3).
 *
 * This is not cosmetic: it is what decides whether the `.git` write fence
 * applies, via `profileTouchesRepo`. A `scratch` role has no repo to fence.
 */
export type ProfileCwdKind = 'scratch' | 'repo_scratch_worktree' | 'ticket_worktree';

/**
 * The sandbox half of a profile (spec §4.3).
 *
 * These lists are *extras*. `buildSandboxSettings` always adds the run's cwd to
 * `allowRead` and always adds the four `.git` paths to `denyWrite` for a
 * repo-touching profile, so a profile that forgets them is still fenced.
 */
export interface SandboxProfile {
  /** `filesystem.denyRead: ["~/"]`. Every M1–M3 profile sets this. */
  readonly denyReadHome: boolean;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

/**
 * A role's permissions as pure data (spec §4.3).
 *
 * The six real profiles are Phase 6's job (`src/agents/profiles.ts`). The type
 * lives here rather than there because `AgentRunSpec` references it and the
 * runner must not import from the agent layer — that would invert the
 * dependency and make `src/runner` untestable without prompts and schemas.
 */
export interface AgentProfile {
  readonly role: Role;
  readonly cwd: ProfileCwdKind;
  /** `--tools` — which built-in tools exist at all. */
  readonly tools: readonly string[];
  /** `--allowedTools` — which may run without a prompt. */
  readonly allowedTools: readonly string[];
  readonly sandbox: SandboxProfile;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
}

/**
 * Does this profile work inside the target repo?
 *
 * Written as an exhaustive switch on purpose. A boolean field on the profile
 * could be left `false` by a future author and would silently drop the `.git`
 * fence; a new `ProfileCwdKind` here is a compile error, and an unrecognised
 * value at runtime throws rather than returning `false`.
 */
export function profileTouchesRepo(profile: Pick<AgentProfile, 'cwd'>): boolean {
  switch (profile.cwd) {
    case 'scratch':
      return false;
    case 'repo_scratch_worktree':
    case 'ticket_worktree':
      return true;
    default: {
      const unreachable: never = profile.cwd;
      throw new Error(
        `unknown profile cwd kind ${JSON.stringify(unreachable)} — refusing to decide whether ` +
          'the .git write fence applies. Add the new kind to profileTouchesRepo().',
      );
    }
  }
}

/** The outcome of validating an agent's `structured_output` (spec §5 rule 1). */
export type StructuredValidation = { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Belt-and-braces validation of the payload the CLI already validated.
 *
 * Optional on the spec. When absent the runner still refuses anything that is
 * not a non-null object, so "no validator" degrades to a weaker check rather
 * than to no check at all.
 */
export type StructuredValidator = (value: unknown) => StructuredValidation;

/**
 * One agent invocation (spec §8.1).
 *
 * Extended beyond §8.1 with `itemId`, `featureSlug` and `attempt`. Spec §12
 * requires the `.runs/<run-id>.json` entry to carry `{role, ticket, feature,
 * attempt, ...}` and §12 puts the transcript at
 * `logs/<slug>/<item>-<attempt>-<role>.log`, none of which is derivable from
 * the §8.1 field set. `MockRunner`'s fixture map is keyed on role + item id for
 * the same reason. Every original §8.1 field is kept verbatim.
 */
export interface AgentRunSpec {
  readonly runId: string;
  readonly role: Role;
  /** The directory the child process runs in. There is no `--cwd` flag (spec §4.1). */
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPromptAppend: string;
  readonly profile: AgentProfile;
  /** JSON Schema, handed to `--json-schema`. Phase 6 derives it from zod. */
  readonly outputSchema: object;
  readonly model: string;
  readonly transcriptPath: string;

  // --- additions, see the note above ---
  /** Ticket id or feature id this run is for. */
  readonly itemId: string;
  readonly featureSlug: string;
  readonly attempt: number;
  /** Optional runtime re-validation of `structured_output`. */
  readonly validateStructured?: StructuredValidator;
}

/** What the orchestrator gets back (spec §8.1). */
export interface AgentRunResult {
  /** `is_error === false` **and** the structured payload validated. */
  readonly ok: boolean;
  readonly structured: unknown | null;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly sessionId: string;
  readonly terminalReason: string;
  /**
   * How many times the agent called the `StructuredOutput` tool during the run
   * (plan Phase 7b, raised by its ledger).
   *
   * **Above 1 means the CLI retried delivery.** Phase 7b established that the
   * binding constraint on agent output is not the model's token ceiling but
   * the CLI's `StructuredOutput` delivery, and that it fails by mangling
   * parameter boundaries: the model emits a correct payload, the CLI glues one
   * field onto the end of the previous one, and the call is rejected for a
   * property the agent did send. Rejected and accepted sizes overlap
   * completely, so no size threshold discriminates — the call count is the
   * only early warning that a role's payload is nearing the size at which
   * delivery starts failing.
   *
   * The orchestrator handles each instance correctly — one attempt charged,
   * retried, and it has always succeeded — which is precisely the problem: the
   * failure is invisible unless a human reads a transcript.
   *
   * **Not optional, and present whatever the outcome.** The run it matters
   * most for is the one that ends `terminalReason:
   * "structured_output_retry_exhausted"`, which arrives as `is_error: true`
   * and leaves `interpretRun` at check 4. A count that only existed on
   * `ok: true` would be there for every healthy run and missing for every run
   * that actually ran out of retries. On a crash or a timeout the honest
   * answer is "however many we saw before it died", which is what this is.
   *
   * Counted from the live stream, never by re-reading the transcript: the
   * transcript is the record, and `MockRunner` has none to read. The rule is
   * the one `test/integration/pipeline-real.test.ts`'s `payloadSizes()`
   * already uses, so the production number and the paid test's number cannot
   * disagree.
   */
  readonly structuredOutputCalls: number;
  /** Hint only — spec §4.1 records that this is empty even when access was blocked. */
  readonly permissionDenials: unknown[];
  readonly failure?: AgentFailure;
  /**
   * The raw `structured_output` as it arrived, kept even when validation failed
   * so the event log can record what the agent actually said (plan Phase 5,
   * `streamParse` case 4).
   */
  readonly rawStructured?: unknown;
  /** Populated on `failure: 'schema'`. */
  readonly schemaIssues?: readonly string[];
}

export interface Runner {
  run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult>;
}
