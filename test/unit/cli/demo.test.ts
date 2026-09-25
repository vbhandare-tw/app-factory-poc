/**
 * `factory demo` (dashboard plan Phase 6): the command's flags, and the refusals
 * that happen before anything is written. The run itself is
 * `test/integration/dashboard-demo.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../../src/config/registry.js';
import type { CliDeps } from '../../../src/cli/deps.js';
import { CliError } from '../../../src/cli/deps.js';
import { demoLayout, runDemo } from '../../../src/cli/demo.js';
import { buildProgram } from '../../../src/cli/main.js';
import { scratchDir } from '../../helpers/toyRepo.js';

function deps(home: string, out: string[] = []): CliDeps {
  return {
    cwd: home,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    now: () => new Date().toISOString(),
  };
}

describe('buildProgram', () => {
  it('registers `demo` with --port, --no-open and --fresh, and no arguments', () => {
    const command = buildProgram(deps('/nowhere')).commands.find((c) => c.name() === 'demo');
    expect(command).toBeDefined();
    expect(command!.options.map((option) => option.flags)).toEqual(['--port <n>', '--no-open', '--fresh']);
    expect(command!.registeredArguments).toEqual([]);
  });
});

describe('demoLayout', () => {
  it('keeps the demo in <factory home>/demo, beside projects.yml rather than in it', () => {
    expect(demoLayout('/home/someone/.app-factory')).toEqual({
      root: '/home/someone/.app-factory/demo',
      repo: '/home/someone/.app-factory/demo/repo',
      vault: '/home/someone/.app-factory/demo/vault',
    });
  });
});

describe('runDemo', () => {
  it('refuses a factory home under a temp directory, where worktrees would be unfenced, and creates nothing', async () => {
    const home = path.join(os.tmpdir(), `app-factory-demo-never-created-${randomBytes(6).toString('hex')}`);
    const out: string[] = [];

    const error = await runDemo({ port: 0, open: false }, deps(home, out), {
      signals: new EventEmitter(),
      openUrl: () => undefined,
      exit: () => undefined,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('FACTORY_HOME');
    expect(existsSync(home)).toBe(false);
    expect(out).toEqual([]);
  });

  it('refuses a half-deleted demo instead of wiping what is left, unless --fresh', async () => {
    const home = scratchDir('demo-incomplete-');
    try {
      const vaultConfig = path.join(demoLayout(home).vault, 'config.yml');
      mkdirSync(path.dirname(vaultConfig), { recursive: true });
      writeFileSync(vaultConfig, 'runner: "demo"\n', 'utf8');

      const error = await runDemo({ port: 0, open: false }, deps(home), {
        signals: new EventEmitter(),
        openUrl: () => undefined,
        exit: () => undefined,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toMatch(/incomplete \(missing its repo\)\. Pass --fresh/);
      expect(existsSync(vaultConfig)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
