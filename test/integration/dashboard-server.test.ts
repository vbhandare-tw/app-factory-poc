/**
 * The dashboard HTTP server on a real socket (port 0, 127.0.0.1): host check,
 * method and token checks, static serving confined to the UI root, and the
 * read API wired end to end.
 */
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildStatusReport } from '../../src/cli/status.js';
import type { VaultScope } from '../../src/cli/resolve.js';
import { DASHBOARD_HOST } from '../../src/dashboard/constants.js';
import { readRouter } from '../../src/dashboard/handlers/read.js';
import { uiRoot } from '../../src/dashboard/paths.js';
import { RunIndex } from '../../src/dashboard/runIndex.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { newSessionToken } from '../../src/dashboard/security.js';
import { ShellGit } from '../../src/git/git.js';
import { makeFeature } from '../helpers/notes.js';
import { factoryVault } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, scratchDir } from '../helpers/toyRepo.js';

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

let vault: FactoryFixture;
let scope: VaultScope;
let token: string;
let server: http.Server;
let port: number;
let scratchUiServer: http.Server;
let scratchUiPort: number;
const replies: Reply[] = [];

function request(
  targetPort: number,
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: DASHBOARD_HOST,
        port: targetPort,
        method,
        path: rawPath,
        headers: { host: `127.0.0.1:${targetPort}`, connection: 'close', ...headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const reply = { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
          replies.push(reply);
          resolve(reply);
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (rawPath: string, headers: Record<string, string> = {}): Promise<Reply> =>
  request(port, 'GET', rawPath, headers);

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, DASHBOARD_HOST, () => resolve((s.address() as AddressInfo).port));
  });
}

function close(s: http.Server | undefined): Promise<void> {
  if (s === undefined || !s.listening) return Promise.resolve();
  return new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

beforeAll(async () => {
  vault = factoryVault();
  mkdirSync(vault.paths.featureDir('alpha'), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.featureNote('alpha'),
    makeFeature({
      id: 'FEAT-ALPHA',
      slug: 'alpha',
      title: 'Alpha',
      status: 'needs_human',
      pause_reason: 'checkpoint',
      pause_detail: 'after_pm_refinement',
      resume_to: 'planning',
      reject_to: 'refining',
      paused_at: '2026-09-24T09:00:00.000Z',
    }),
  );

  const shell = new ShellGit({ repoRoot: vault.repo.path });
  scope = {
    vaultPath: vault.root,
    config: vault.config,
    paths: vault.paths,
    storage: vault.storage,
    resolution: { vaultPath: vault.root, source: 'flag', projectName: null },
    actionContext: {
      paths: vault.paths,
      storage: vault.storage,
      config: vault.config,
      now: () => '2026-09-24T10:00:00.000Z',
      git: shell,
    },
  };
  const router = readRouter({
    scope,
    lockView: () => Promise.resolve({ mode: 'stopped', pid: null, heartbeatAt: null }),
    git: shell,
    runIndex: new RunIndex(),
  });

  token = newSessionToken();
  server = createDashboardServer({ token, router });
  port = await listen(server);

  // A UI root with a same-prefix sibling and an outward symlink next to it.
  const base = scratchDir('dash-ui-');
  const ui = path.join(base, 'pkg', 'ui');
  mkdirSync(path.join(ui, 'components'), { recursive: true });
  copyFileSync(path.join(uiRoot(), 'index.html'), path.join(ui, 'index.html'));
  writeFileSync(path.join(ui, 'app.js'), 'export const ok = 1;\n');
  writeFileSync(path.join(ui, 'components', 'x.css'), 'body{}\n');
  writeFileSync(path.join(base, 'package.json'), '{"name":"leak-base"}\n');
  writeFileSync(path.join(base, 'pkg', 'package.json'), '{"name":"leak-pkg"}\n');
  mkdirSync(path.join(base, 'pkg', 'ui-evil'));
  writeFileSync(path.join(base, 'pkg', 'ui-evil', 'secret.txt'), 'leak-sibling\n');
  symlinkSync(path.join(base, 'package.json'), path.join(ui, 'link.json'));

  scratchUiServer = createDashboardServer({ token, router, uiRoot: ui });
  scratchUiPort = await listen(scratchUiServer);
});

afterAll(async () => {
  await close(server);
  await close(scratchUiServer);
  vault.cleanup();
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('GET /', () => {
  it('returns the shell HTML with the session token injected', async () => {
    const reply = await get('/');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body).toContain(`<meta name="factory-token" content="${token}">`);
    expect(reply.body).not.toContain('<meta name="factory-token" content="">');
  });

  it('forbids framing, so the page cannot be clickjacked', async () => {
    const reply = await get('/');
    expect(reply.headers['x-frame-options']).toBe('DENY');
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('Host check', () => {
  it.each([
    ['evil.com', '/api/state'],
    ['evil.com', '/'],
    ['evil.com', '/assets/index.html'],
    ['evil.com', '/no/such/path'],
    ['127.0.0.1.evil.com', '/api/state'],
    ['localhost:1', '/api/state'],
    ['127.0.0.1', '/api/state'],
  ])('Host: %s on %s → 421', async (host, rawPath) => {
    const reply = await get(rawPath, { host });
    expect(reply.status).toBe(421);
    expect(JSON.parse(reply.body)).toHaveProperty('message');
  });

  it('accepts localhost on the bound port', async () => {
    expect((await get('/api/state', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('answers 421 before the token check on a POST', async () => {
    const reply = await request(port, 'POST', '/api/state', { host: 'evil.com', 'x-factory-token': token }, '{}');
    expect(reply.status).toBe(421);
  });
});

describe('methods, token and CORS', () => {
  it('OPTIONS /api/state → 405', async () => {
    expect((await request(port, 'OPTIONS', '/api/state')).status).toBe(405);
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'HEAD', 'TRACE'])('%s /api/state → 405', async (method) => {
    expect((await request(port, method, '/api/state')).status).toBe(405);
  });

  it('POST without the token → 403', async () => {
    expect((await request(port, 'POST', '/api/state', {}, '{}')).status).toBe(403);
  });

  it('POST with a wrong token → 403', async () => {
    const wrong = newSessionToken();
    expect((await request(port, 'POST', '/api/state', { 'x-factory-token': wrong }, '{}')).status).toBe(403);
  });

  it('POST with the token reaches the router (no write routes yet → 405)', async () => {
    const reply = await request(port, 'POST', '/api/state', { 'x-factory-token': token }, '{}');
    expect(reply.status).toBe(405);
    expect(reply.headers['allow']).toBe('GET');
  });

  it('never sends an Access-Control-* header on any response', async () => {
    await request(port, 'OPTIONS', '/api/state', { origin: 'https://evil.com', 'access-control-request-method': 'POST' });
    await get('/api/state', { origin: 'https://evil.com' });
    expect(replies.length).toBeGreaterThan(10);
    for (const reply of replies) {
      expect(Object.keys(reply.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('static assets', () => {
  it('serves a file from the UI root with a content type and no-store', async () => {
    const reply = await request(scratchUiPort, 'GET', '/assets/app.js');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.body).toBe('export const ok = 1;\n');
  });

  it('serves a nested file', async () => {
    const reply = await request(scratchUiPort, 'GET', '/assets/components/x.css');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it.each([
    '/assets/../../package.json',
    '/assets/%2e%2e/%2e%2e/package.json',
    '/assets/%2E%2E/%2E%2E/package.json',
    '/assets/..%2f..%2fpackage.json',
    '/assets/..%2F..%2Fpackage.json',
    '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
    '/assets/..%5c..%5cpackage.json',
    '/assets/%2Fetc%2Fpasswd',
    '/assets/..%2fpackage.json',
  ])('GET %s → 404 (real UI root)', async (rawPath) => {
    const reply = await get(rawPath);
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('app-factory-poc');
  });

  it.each([
    ['a `..` escape to a file that exists', '/assets/..%2f..%2fpackage.json', 'leak-base'],
    ['a one-level `..` escape', '/assets/..%2fpackage.json', 'leak-pkg'],
    ['a same-prefix sibling directory', '/assets/..%2fui-evil%2fsecret.txt', 'leak-sibling'],
    ['a symlink inside the UI root pointing out', '/assets/link.json', 'leak-base'],
    ['an encoded-dot escape', '/assets/%2e%2e%2f%2e%2e%2fpackage.json', 'leak-base'],
  ])('refuses %s → 404 (scratch UI root)', async (_label, rawPath, marker) => {
    const reply = await request(scratchUiPort, 'GET', rawPath);
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain(marker);
  });

  it('404s a directory', async () => {
    expect((await request(scratchUiPort, 'GET', '/assets/components')).status).toBe(404);
  });
});

describe('API', () => {
  it('GET /api/state on a vault with one paused feature matches buildStatusReport', async () => {
    const reply = await get('/api/state');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    const body = JSON.parse(reply.body) as Record<string, unknown>;

    const { needs_human: reportNeedsHuman, ...rest } = await buildStatusReport(scope.resolution);
    expect(body).toMatchObject(rest);
    expect(reportNeedsHuman).toHaveLength(1);
    expect(body['needs_human']).toEqual([
      {
        ...reportNeedsHuman[0],
        kind: 'feature',
        resume_to: 'planning',
        reject_to: 'refining',
        paused_at: '2026-09-24T09:00:00.000Z',
      },
    ]);
    expect(body).toMatchObject({ mode: 'stopped', demo: false, killed: false });
  });

  it('GET /api/features/:slug returns the feature', async () => {
    const reply = await get('/api/features/alpha');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ frontmatter: { id: 'FEAT-ALPHA' } });
  });

  it('an encoded traversal in a slug is a JSON 400', async () => {
    const reply = await get('/api/features/..%2F..%2Fetc');
    expect(reply.status).toBe(400);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(reply.body)).toHaveProperty('message');
  });

  it('an unknown run is a JSON 404 with the spec message', async () => {
    const reply = await get('/api/runs/NOPE/transcript');
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toEqual({ message: 'no transcript for this run (it may not have started)' });
  });

  it('an unknown path is a JSON 404, never HTML', async () => {
    for (const rawPath of ['/api/nope', '/nope', '/favicon.ico']) {
      const reply = await get(rawPath);
      expect(reply.status).toBe(404);
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(reply.body)).toHaveProperty('message');
    }
  });
});
