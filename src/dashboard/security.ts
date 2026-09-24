/** The dashboard's request guards (tech spec §2). Each one fails closed. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

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

async function realpathOrNull(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}
