/**
 * The loopback HTTP surface (tech spec §2, §6). Checks run in order:
 * host → method → token (POST only) → route. Errors are always JSON.
 */
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { uiRoot as defaultUiRoot } from './paths.js';
import { HttpError, readJsonBody } from './router.js';
import type { HandlerResult, Router } from './router.js';
import { checkHost, checkToken, confine } from './security.js';

export interface DashboardServerOptions {
  readonly token: string;
  readonly router: Router;
  readonly uiRoot?: string;
  readonly log?: (message: string) => void;
}

export const TOKEN_META_PLACEHOLDER = '<meta name="factory-token" content="">';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

export function createDashboardServer(options: DashboardServerOptions): http.Server {
  const uiRoot = options.uiRoot ?? defaultUiRoot();
  const log = options.log ?? ((): void => undefined);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`dashboard: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      const message = status === 500 ? 'internal error (see the dashboard terminal)' : (error as Error).message;
      if (!res.headersSent) sendJson(res, status, { message });
      else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { port } = server.address() as AddressInfo;
    if (!checkHost(req.headers.host, port)) {
      throw new HttpError(421, 'this dashboard only answers to 127.0.0.1 and localhost on its own port');
    }

    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new HttpError(405, `${method} is not supported`);
    }

    if (method === 'POST' && !checkToken(req.headers['x-factory-token'], options.token)) {
      throw new HttpError(403, 'missing or wrong X-Factory-Token');
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      throw new HttpError(400, 'malformed request URL');
    }
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const match = options.router.match(method, pathname);
      if (match.kind === 'not_found') throw new HttpError(404, `no endpoint ${pathname}`);
      if (match.kind === 'method_not_allowed') {
        res.setHeader('Allow', match.allowed.join(', '));
        throw new HttpError(405, `${method} is not allowed on ${pathname}`);
      }
      const body = method === 'POST' ? await readJsonBody(req, req.headers) : undefined;
      send(res, await match.handler({ method, path: pathname, params: match.params, query: url.searchParams, body }));
      return;
    }

    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, `${method} is not allowed on ${pathname}`);
    }
    if (pathname === '/') {
      await sendIndex(res);
      return;
    }
    if (pathname.startsWith('/assets/')) {
      await sendAsset(res, pathname.slice('/assets/'.length));
      return;
    }
    throw new HttpError(404, `nothing at ${pathname}`);
  }

  async function sendIndex(res: http.ServerResponse): Promise<void> {
    const html = await readFile(path.join(uiRoot, 'index.html'), 'utf8');
    if (!html.includes(TOKEN_META_PLACEHOLDER)) {
      throw new HttpError(500, 'dashboard-ui/index.html has no factory-token placeholder');
    }
    const page = html.replace(TOKEN_META_PLACEHOLDER, `<meta name="factory-token" content="${options.token}">`);
    sendBody(res, 200, CONTENT_TYPES['.html'] ?? '', page);
  }

  async function sendAsset(res: http.ServerResponse, encoded: string): Promise<void> {
    const notFound = new HttpError(404, 'no such asset');
    let relative: string;
    try {
      relative = decodeURIComponent(encoded);
    } catch {
      throw notFound;
    }
    const file = await confine(path.resolve(uiRoot, relative), [uiRoot]);
    if (file === null || !(await stat(file)).isFile()) throw notFound;
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    sendBody(res, 200, type, await readFile(file));
  }

  return server;
}

function send(res: http.ServerResponse, result: HandlerResult): void {
  if ('text' in result) sendBody(res, result.status, result.contentType, result.text);
  else sendJson(res, result.status, result.json);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendBody(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
