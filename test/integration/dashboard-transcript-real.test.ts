/**
 * `toSteps` against every real transcript kept from the two acceptance runs.
 * Skips (not fails) when `.factory-test-repos/` is absent, e.g. on CI.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toSteps } from '../../src/dashboard/transcriptView.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_LOGS_ROOT = path.join(PROJECT_ROOT, '.factory-test-repos', 'acceptance-logs', 'real');

function findTranscripts(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.log') && !entry.name.includes('-gate-')) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

describe.skipIf(!existsSync(REAL_LOGS_ROOT))('toSteps over the kept real acceptance transcripts', () => {
  const transcripts = existsSync(REAL_LOGS_ROOT) ? findTranscripts(REAL_LOGS_ROOT) : [];

  it('found at least one transcript to check', () => {
    expect(transcripts.length).toBeGreaterThan(0);
  });

  it('produces zero unknown steps for every kept transcript', () => {
    const offenders: { file: string; count: number }[] = [];
    for (const file of transcripts) {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      const steps = toSteps(lines);
      const unknown = steps.filter((s) => s.kind === 'unknown').length;
      if (unknown > 0) offenders.push({ file: path.relative(PROJECT_ROOT, file), count: unknown });
    }
    expect(offenders).toEqual([]);
  });
});
