/**
 * Builds `dist/` once, before any test file runs (plan Phase 5, S3). Files whose
 * child processes import `dist/` read the result with `inject('distBuild')`
 * rather than each running `npm run build` while the others' children load it.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

export interface DistBuild {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    distBuild: DistBuild;
  }
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default function setup(project: TestProject): void {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  if (result.error !== undefined) throw result.error;
  project.provide('distBuild', {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
}
