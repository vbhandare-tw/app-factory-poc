/**
 * `factory feature add <file> [--priority]` (spec §6).
 *
 * Creates `work/features/<slug>/feature.md` in `intake` with `## Raw
 * Requirement` set to the **verbatim** contents of the file.
 *
 * Verbatim is the whole point. Requirements §7 forbids every agent from editing
 * that section, and the reason is that it is the only record of what a human
 * actually asked for. The PM's refinement, the TL's plan and the DL's tickets
 * are all derived from it, and if the original is edited there is nothing left
 * to check the derivation against.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { SECTION } from '../agents/context.js';
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import { featureId, slugify } from '../domain/ids.js';
import { fencedBlock } from '../domain/markdown.js';
import type { FeatureNote, FeaturePriority } from '../domain/types.js';
import { refreshViews } from '../orchestrator/noteWrites.js';
import { VaultPaths } from '../vault/paths.js';
import { appendToSection, MarkdownStorage } from '../vault/storage.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';

export interface FeatureAddOptions {
  readonly file: string;
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  readonly priority?: string | undefined;
  readonly slug?: string | undefined;
  readonly title?: string | undefined;
}

export interface FeatureAddResult {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly path: string;
}

const PRIORITIES: readonly FeaturePriority[] = ['high', 'medium', 'low'];

export async function runFeatureAdd(
  options: FeatureAddOptions,
  deps: CliDeps,
): Promise<FeatureAddResult> {
  const source = path.resolve(deps.cwd, options.file);
  if (!existsSync(source)) {
    throw new CliError(`no such requirement file: ${source}`);
  }

  const priority = options.priority ?? 'medium';
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    throw new CliError(
      `--priority must be one of ${PRIORITIES.join(', ')}, not ${JSON.stringify(priority)}`,
    );
  }

  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );
  await loadConfig(resolution.vaultPath);

  const paths = new VaultPaths(resolution.vaultPath);
  const storage = new MarkdownStorage(paths);

  const raw = await readFile(source, 'utf8');
  const slug = options.slug ?? slugify(path.basename(source, path.extname(source)));
  if (slug.length === 0 || !VaultPaths.isSafeSegment(slug)) {
    throw new CliError(
      `${path.basename(source)} does not give a usable feature slug (${JSON.stringify(slug)}). ` +
        'Rename the file, or pass --slug.',
    );
  }

  const file = paths.featureNote(slug);
  if (existsSync(file)) {
    throw new CliError(
      `${file} already exists — feature ${slug} is already in this vault. Delete it or use a ` +
        'different filename.',
    );
  }

  const now = deps.now();
  const title = options.title ?? firstHeading(raw) ?? slug;

  // A brand-new note: there is no prior frontmatter to preserve, so building
  // the object field by field is correct here. Every *update* path spreads.
  const note: FeatureNote = {
    frontmatter: {
      type: 'feature',
      id: featureId(slug),
      title,
      status: 'intake',
      slug,
      priority: priority as FeaturePriority,
      feature_branch: null,
      tag: null,
      attempts: 0,
      cost_usd: 0,
      created_at: now,
      updated_at: now,
      locked_by: null,
      locked_at: null,
      pause_reason: null,
      pause_detail: null,
      resume_to: null,
      reject_to: null,
      paused_at: null,
    },
    // Fenced, always. Spec §6 says this section is the requirement file
    // **verbatim**, and a requirement with its own `#` headings would otherwise
    // split the section in two — silently, in a way that makes `sectionText`
    // return only the part above the first heading. The fence keeps the bytes
    // exactly as the human wrote them and keeps the section whole.
    body: appendToSection('', SECTION.rawRequirement, fencedBlock(raw, 'markdown')),
  };

  await storage.writeNote(file, note);
  await refreshViews({ storage, paths });

  deps.out(`Added ${note.frontmatter.id} (${slug}) in intake`);
  deps.out(`  note: ${file}`);

  return { id: note.frontmatter.id, slug, title, path: file };
}

/** The first `# ` heading in the requirement, used as the feature title. */
function firstHeading(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[1].length > 0) return match[1];
  }
  return null;
}
