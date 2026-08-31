import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { run } from '../helpers/toyRepo.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Manifest {
  version: string;
}

describe('the factory itself builds and runs', () => {
  beforeAll(() => {
    const build = run(PROJECT_ROOT, 'npm', ['run', 'build']);
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  });

  it('npm run build produces dist/cli/main.js', () => {
    expect(existsSync(path.join(PROJECT_ROOT, 'dist', 'cli', 'main.js'))).toBe(true);
  });

  it('node dist/cli/main.js --version prints the package version', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as Manifest;

    const result = run(PROJECT_ROOT, 'node', ['dist/cli/main.js', '--version']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });

  it('node dist/cli/main.js --help names the binary', () => {
    const result = run(PROJECT_ROOT, 'node', ['dist/cli/main.js', '--help']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('factory');
  });

  it('the built domain layer is importable from dist', async () => {
    const domain = (await import(path.join(PROJECT_ROOT, 'dist', 'index.js'))) as {
      ROLES: readonly string[];
    };
    expect(domain.ROLES).toEqual(['pm', 'tl_plan', 'dl', 'developer', 'code_reviewer', 'qa']);
  });
});
