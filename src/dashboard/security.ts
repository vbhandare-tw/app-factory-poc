/** The dashboard's request guards (tech spec §2). Each one fails closed. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { VaultPaths } from '../vault/paths.js';
import { allowedHosts } from './constants.js';

/** Exact match against the allowlist for the bound port (DNS-rebinding guard). */
export function checkHost(header: string | undefined, port: number): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  return allowedHosts(port).includes(header.toLowerCase());
}

/** Constant-time compare; a missing, repeated or different-length header is simply false. */
export function checkToken(header: string | readonly string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || token.length === 0) return false;
  const given = Buffer.from(header, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The realpath of `file` if it is strictly inside one of `roots` (both sides
 * resolved through symlinks), otherwise `null`. Relative input is refused.
 */
export async function confine(file: string, roots: readonly string[]): Promise<string | null> {
  if (!path.isAbsolute(file) || file.includes('\0')) return null;
  const real = await realpathOrNull(file);
  if (real === null) return null;

  for (const root of roots) {
    const realRoot = await realpathOrNull(root);
    if (realRoot === null) continue;
    const relative = path.relative(realRoot, real);
    if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      return real;
    }
  }
  return null;
}

/**
 * A recorded log path (an event's `logPath`), confined to `logsDir`. A moved or
 * archived vault recorded its paths under its old root, so a path that fails is
 * retried as `<logsDir>/<slug>/<file>` from its last two segments (plan Phase 5).
 */
export async function confineLogFile(logPath: string, logsDir: string): Promise<string | null> {
  const recorded = await confine(logPath, [logsDir]);
  if (recorded !== null) return recorded;
  const rebuilt = rebuiltLogPath(logPath, logsDir);
  return rebuilt === null ? null : await confine(rebuilt, [logsDir]);
}

/**
 * Where to watch for a log that may not exist yet: the recorded path when it is
 * inside `logsDir`, else the rebuilt one. Reads must still go through `confine`.
 */
export function liveLogPath(logPath: string, logsDir: string): string | null {
  if (path.isAbsolute(logPath) && !logPath.includes('\0')) {
    const resolved = path.resolve(logPath);
    const relative = path.relative(path.resolve(logsDir), resolved);
    if (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return resolved;
    }
  }
  return rebuiltLogPath(logPath, logsDir);
}

function rebuiltLogPath(logPath: string, logsDir: string): string | null {
  const segments = logPath.split('/');
  const file = segments.at(-1) ?? '';
  const slug = segments.at(-2) ?? '';
  if (!VaultPaths.isSafeSegment(slug) || !VaultPaths.isSafeSegment(file)) return null;
  return path.join(logsDir, slug, file);
}

async function realpathOrNull(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}
