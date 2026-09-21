import type { FeatureState, GateName, TicketState } from '../../src/domain/states.js';
import type {
  FeatureFrontmatter,
  FeatureNote,
  GateResultSummary,
  TicketFrontmatter,
  TicketNote,
} from '../../src/domain/types.js';

export const T0 = '2026-01-01T00:00:00Z';

export function gateResult(status: GateResultSummary['status']): GateResultSummary {
  return {
    status,
    exit_code: status === 'pass' ? 0 : 1,
    duration_ms: 10,
    output: '',
    log_path: 'logs/gate.log',
  };
}

export function greenGates(): Record<GateName, GateResultSummary> {
  return { tests: gateResult('pass'), lint: gateResult('pass'), build: gateResult('pass') };
}

export function makeTicket(
  overrides: Partial<TicketFrontmatter> = {},
  body = '',
): TicketNote {
  const frontmatter: TicketFrontmatter = {
    type: 'ticket',
    id: 'FEAT-X-T001',
    title: 'A ticket',
    status: 'backlog' satisfies TicketState,
    feature: 'x',
    ordinal: 1,
    depends_on: [],
    attempts: 0,
    max_attempts: null,
    branch: null,
    worktree: null,
    gate_results: null,
    cost_usd: 0,
    created_at: T0,
    updated_at: T0,
    locked_by: null,
    locked_at: null,
    pause_reason: null,
    pause_detail: null,
    resume_to: null,
    reject_to: null,
    paused_at: null,
    ...overrides,
  };
  return { frontmatter, body };
}

export function makeFeature(
  overrides: Partial<FeatureFrontmatter> = {},
  body = '',
): FeatureNote {
  const frontmatter: FeatureFrontmatter = {
    type: 'feature',
    id: 'FEAT-X',
    title: 'A feature',
    status: 'intake' satisfies FeatureState,
    slug: 'x',
    priority: 'medium',
    feature_branch: null,
    tag: null,
    verified_sha: null,
    base_verified_sha: null,
    approved_sha: null,
    approved_note: null,
    approved_tag: null,
    attempts: 0,
    cost_usd: 0,
    created_at: T0,
    updated_at: T0,
    locked_by: null,
    locked_at: null,
    pause_reason: null,
    pause_detail: null,
    resume_to: null,
    reject_to: null,
    paused_at: null,
    ...overrides,
  };
  return { frontmatter, body };
}

/** Recursively freeze an object so any mutation attempt throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
