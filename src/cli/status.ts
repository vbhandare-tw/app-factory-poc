/**
 * `factory status [project] [--json]` (spec §6).
 *
 * `--json` exists so tests and the M7 dashboard read a contract rather than
 * scraping formatted text. The human and JSON views are built from the same
 * `StatusReport`, so they cannot drift apart.
 */
import { readdir, readFile } from 'node:fs/promises';

import { TICKET_STATES } from '../domain/states.js';
import type { TicketState } from '../domain/states.js';
import { MarkdownStorage } from '../vault/storage.js';
import { VaultPathError, VaultPaths } from '../vault/paths.js';
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import type { VaultResolution, VaultSource } from '../config/resolve.js';
import type { CliDeps } from './deps.js';
import { readLock } from './projects.js';

export interface StatusOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
}

export interface FeatureStatus {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly tickets: number;
  readonly ticketsByState: Partial<Record<TicketState, number>>;
  /**
   * `factory/<slug>/<ISO date>` on a `done` feature; `null` otherwise (Phase 11).
   *
   * Reported because `done` *means* merged into the base branch and tagged, and
   * the tag is the only part of that a human can check without opening git. A
   * `done` feature showing no tag is a discrepancy worth seeing rather than one
   * worth hiding — `featureCloseVerified` should make it impossible, and this is
   * where it would show up if it ever were not.
   */
  readonly tag: string | null;
}

export interface NeedsHumanItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly pause_reason: string | null;
  readonly pause_detail: string | null;
}

export interface RunningAgent {
  readonly run_id: string;
  readonly role: string | null;
  readonly item: string | null;
  readonly pid: number | null;
}

export interface StatusReport {
  readonly vault: string;
  readonly project: string | null;
  readonly source: VaultSource;
  readonly target_repo: string;
  readonly base_branch: string;
  readonly orchestrator: 'running' | 'stopped' | 'stale-lock';
  readonly features: readonly FeatureStatus[];
  readonly totals: { readonly features: number; readonly tickets: number };
  readonly needs_human: readonly NeedsHumanItem[];
  readonly running: readonly RunningAgent[];
}

export async function runStatus(options: StatusOptions, deps: CliDeps): Promise<StatusReport> {
  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );

  const report = await buildStatusReport(resolution);

  if (options.json === true) deps.out(JSON.stringify(report, null, 2));
  else for (const line of formatReport(report)) deps.out(line);

  return report;
}

export async function buildStatusReport(resolution: VaultResolution): Promise<StatusReport> {
  const config = await loadConfig(resolution.vaultPath);
  const paths = new VaultPaths(resolution.vaultPath);
  const storage = new MarkdownStorage(paths);

  const features: FeatureStatus[] = [];
  const needsHuman: NeedsHumanItem[] = [];
  let ticketTotal = 0;

  for (const feature of await storage.listFeatures()) {
    const front = feature.frontmatter;
    const tickets = await storage.listTickets(front.slug);
    ticketTotal += tickets.length;

    const byState: Partial<Record<TicketState, number>> = {};
    for (const state of TICKET_STATES) {
      const count = tickets.filter((ticket) => ticket.frontmatter.status === state).length;
      if (count > 0) byState[state] = count;
    }

    features.push({
      id: front.id,
      slug: front.slug,
      title: front.title,
      status: front.status,
      tickets: tickets.length,
      ticketsByState: byState,
      tag: front.tag,
    });

    if (front.status === 'needs_human') needsHuman.push(toNeedsHuman(front));
    for (const ticket of tickets) {
      if (ticket.frontmatter.status === 'needs_human') needsHuman.push(toNeedsHuman(ticket.frontmatter));
    }
  }

  const lock = readLock(resolution.vaultPath);
  const report: StatusReport = {
    vault: resolution.vaultPath,
    project: resolution.projectName,
    source: resolution.source,
    target_repo: config.target_repo,
    base_branch: config.base_branch,
    orchestrator: lock === null ? 'stopped' : isAlive(lock.pid) ? 'running' : 'stale-lock',
    features,
    totals: { features: features.length, tickets: ticketTotal },
    needs_human: needsHuman,
    running: await readRunning(paths),
  };

  return report;
}

export function formatReport(report: StatusReport): string[] {
  const lines: string[] = [
    `Vault:      ${report.vault}${report.project === null ? '' : ` (${report.project})`}`,
    `Repo:       ${report.target_repo} @ ${report.base_branch}`,
    `Orchestrator: ${report.orchestrator}`,
    '',
  ];

  if (report.features.length === 0) {
    lines.push('No features yet. Add one with `factory feature add <file>`.');
  } else {
    lines.push('Features:');
    for (const feature of report.features) {
      const breakdown = Object.entries(feature.ticketsByState)
        .map(([state, count]) => `${state}=${count}`)
        .join(' ');
      // A `done` feature is one that is on the base branch and tagged, so the
      // tag is the interesting fact about it and the ticket breakdown is not.
      // `(untagged)` is said out loud rather than left blank: a `done` feature
      // with no tag means the delivery record is incomplete, and a blank column
      // reads as "nothing to report".
      const delivery =
        feature.status === 'done'
          ? `  ${feature.tag === null || feature.tag === '' ? '(untagged)' : `tag ${feature.tag}`}`
          : '';
      lines.push(
        `  ${feature.slug}  ${feature.status}  ${feature.tickets} ticket(s)${breakdown === '' ? '' : `  ${breakdown}`}${delivery}`,
      );
    }
  }

  lines.push('', `Needs human: ${report.needs_human.length}`);
  for (const item of report.needs_human) {
    lines.push(`  ${item.id}  ${item.pause_reason ?? 'unspecified'}`);
  }
  lines.push(`Running agents: ${report.running.length}`);
  return lines;
}

function toNeedsHuman(front: {
  id: string;
  title: string;
  status: string;
  pause_reason: string | null;
  pause_detail: string | null;
}): NeedsHumanItem {
  return {
    id: front.id,
    title: front.title,
    status: front.status,
    pause_reason: front.pause_reason,
    pause_detail: front.pause_detail,
  };
}

/** `.runs/<run-id>.json`, written at spawn and deleted on completion (spec §12). */
async function readRunning(paths: VaultPaths): Promise<RunningAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.runsDir());
  } catch {
    return [];
  }

  const running: RunningAgent[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const runId = entry.replace(/\.json$/, '');

    // Back through the path seam rather than joining here. A readdir entry
    // cannot contain a separator, so nothing can traverse — but `paths.ts` is
    // the single place vault paths are built, and one exception is how that
    // stops being true. An id the seam rejects is reported rather than read.
    let file: string;
    try {
      file = paths.runFile(runId);
    } catch (error) {
      if (!(error instanceof VaultPathError)) throw error;
      running.push({ run_id: runId, role: null, item: null, pid: null });
      continue;
    }

    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const record = (raw ?? {}) as Record<string, unknown>;
      running.push({
        run_id: runId,
        role: typeof record['role'] === 'string' ? record['role'] : null,
        item: typeof record['ticket'] === 'string' ? record['ticket'] : null,
        pid: typeof record['pid'] === 'number' ? record['pid'] : null,
      });
    } catch {
      // A half-written run file must not break `factory status` — the whole
      // point of the command is being usable when something has gone wrong.
      running.push({ run_id: runId, role: null, item: null, pid: null });
    }
  }
  return running;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
