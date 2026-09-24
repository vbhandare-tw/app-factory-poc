/**
 * The dashboard's three request guards (tech spec §2): the Host allowlist, the
 * mutation token, and path confinement on realpath.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkHost, checkToken, confine, newSessionToken } from '../../../src/dashboard/security.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

describe('checkHost', () => {
  const PORT = 4317;

  it('accepts 127.0.0.1 and localhost on the bound port', () => {
    expect(checkHost('127.0.0.1:4317', PORT)).toBe(true);
    expect(checkHost('localhost:4317', PORT)).toBe(true);
  });

  it('matches the host name case-insensitively, as HTTP does', () => {
    expect(checkHost('LOCALHOST:4317', PORT)).toBe(true);
  });

  it.each([
    ['a foreign host', 'evil.com'],
    ['a foreign host on the right port', 'evil.com:4317'],
    ['a wrong port', '127.0.0.1:4318'],
    ['localhost on a wrong port', 'localhost:1'],
    ['a port that only starts with the right digits', '127.0.0.1:43170'],
    ['no port at all', '127.0.0.1'],
    ['an empty header', ''],
    ['a rebinding name that starts with the loopback address', '127.0.0.1.evil.com'],
    ['a rebinding name that starts with the full allowed value', '127.0.0.1:4317.evil.com'],
    ['a name that contains the allowed value', 'x127.0.0.1:4317'],
    ['the wildcard address', '0.0.0.0:4317'],
    ['IPv6 loopback', '[::1]:4317'],
  ])('rejects %s (%s)', (_label, header) => {
    expect(checkHost(header, PORT)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkHost(undefined, PORT)).toBe(false);
  });
});

describe('checkToken', () => {
  const token = newSessionToken();

  it('accepts the exact token', () => {
    expect(checkToken(token, token)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(checkToken(undefined, token)).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(checkToken('', token)).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(wrong).toHaveLength(token.length);
    expect(checkToken(wrong, token)).toBe(false);
  });

  it('rejects shorter and longer tokens without throwing', () => {
    expect(() => checkToken(token.slice(0, 10), token)).not.toThrow();
    expect(checkToken(token.slice(0, 10), token)).toBe(false);
    expect(checkToken(`${token}00`, token)).toBe(false);
  });

  it('rejects a header sent twice (an array)', () => {
    expect(checkToken([token, token], token)).toBe(false);
  });

  it('never accepts when the expected token is empty', () => {
    expect(checkToken('', '')).toBe(false);
  });

  it('rejects a token that differs only in a multi-byte character', () => {
    expect(checkToken(`${token.slice(0, -1)}é`, token)).toBe(false);
  });
});

describe('newSessionToken', () => {
  it('is 32 random bytes as hex, and differs every call', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('confine', () => {
  let base: string;
  let logs: string;
  let inside: string;
  let secret: string;

  beforeAll(() => {
    base = scratchDir('dash-confine-');
    logs = path.join(base, 'logs');
    mkdirSync(path.join(logs, 'calc'), { recursive: true });
    inside = path.join(logs, 'calc', 'run.log');
    writeFileSync(inside, 'inside\n');
    secret = path.join(base, 'secret.txt');
    writeFileSync(secret, 'secret\n');

    // A sibling whose name starts with the root's name.
    mkdirSync(path.join(base, 'logs-evil'));
    writeFileSync(path.join(base, 'logs-evil', 'x.log'), 'sibling\n');

    symlinkSync(secret, path.join(logs, 'calc', 'link.log'));
    symlinkSync(path.join(base, 'logs-evil'), path.join(logs, 'linkdir'));
    symlinkSync(logs, path.join(base, 'logs-alias'));

    mkdirSync(path.join(base, 'other'));
    writeFileSync(path.join(base, 'other', 'y.log'), 'other\n');
  });

  afterAll(() => {
    cleanupAllScratchDirs();
  });

  it('returns the realpath of a file inside the root', async () => {
    expect(await confine(inside, [logs])).toBe(realpathSync(inside));
  });

  it('rejects a `..` escape that is not normalised away', async () => {
    expect(await confine(`${logs}/calc/../../secret.txt`, [logs])).toBeNull();
  });

  it('rejects an absolute path outside the root', async () => {
    expect(await confine(secret, [logs])).toBeNull();
  });

  it('rejects a sibling directory whose name has the root as a prefix', async () => {
    expect(await confine(path.join(base, 'logs-evil', 'x.log'), [logs])).toBeNull();
  });

  it('rejects a symlinked file inside the root that points outside', async () => {
    expect(await confine(path.join(logs, 'calc', 'link.log'), [logs])).toBeNull();
  });

  it('rejects a file under a symlinked directory that points outside', async () => {
    expect(await confine(path.join(logs, 'linkdir', 'x.log'), [logs])).toBeNull();
  });

  it('accepts a file reached through a symlinked alias of the root', async () => {
    expect(await confine(path.join(base, 'logs-alias', 'calc', 'run.log'), [logs])).toBe(
      realpathSync(inside),
    );
  });

  it('accepts a file when the root itself is given through a symlink', async () => {
    expect(await confine(inside, [path.join(base, 'logs-alias')])).toBe(realpathSync(inside));
  });

  it('rejects the root directory itself', async () => {
    expect(await confine(logs, [logs])).toBeNull();
  });

  it('rejects a missing file', async () => {
    expect(await confine(path.join(logs, 'calc', 'nope.log'), [logs])).toBeNull();
  });

  it('rejects a relative path rather than resolving it against the cwd', async () => {
    expect(await confine('logs/calc/run.log', [logs])).toBeNull();
  });

  it('rejects a path containing a NUL byte', async () => {
    expect(await confine(`${inside}\0.txt`, [logs])).toBeNull();
  });

  it('rejects everything when the root does not exist', async () => {
    expect(await confine(inside, [path.join(base, 'missing-root')])).toBeNull();
  });

  it('accepts a file under any one of several roots', async () => {
    expect(await confine(path.join(base, 'other', 'y.log'), [logs, path.join(base, 'other')])).toBe(
      realpathSync(path.join(base, 'other', 'y.log')),
    );
  });
});
