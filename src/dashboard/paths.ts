/**
 * Package-relative locations (plan A6). `../../` is the package root from both
 * `src/dashboard/` and `dist/dashboard/`, the same trick `readManifest()` uses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

/** The static dashboard shell, served as-is (no build step). */
export function uiRoot(): string {
  return path.join(packageRoot(), 'dashboard-ui');
}

export function toyAppRoot(): string {
  return path.join(packageRoot(), 'fixtures', 'toy-app');
}
