import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageRoot, toyAppRoot, uiRoot } from '../../../src/dashboard/paths.js';
import { TOY_APP_FIXTURE } from '../../helpers/toyRepo.js';

describe('dashboard package paths (plan A6)', () => {
  it('packageRoot is the directory holding this package.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('app-factory-poc');
    expect(packageRoot().endsWith(path.sep)).toBe(false);
  });

  it('uiRoot is dashboard-ui/ and holds the shell with the token placeholder', () => {
    expect(uiRoot()).toBe(path.join(packageRoot(), 'dashboard-ui'));
    expect(readFileSync(path.join(uiRoot(), 'index.html'), 'utf8')).toContain(
      '<meta name="factory-token" content="">',
    );
  });

  it('toyAppRoot is fixtures/toy-app', () => {
    expect(toyAppRoot()).toBe(TOY_APP_FIXTURE);
    expect(existsSync(path.join(toyAppRoot(), 'package.json'))).toBe(true);
  });
});
