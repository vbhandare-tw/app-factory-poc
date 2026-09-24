/** `(method, pattern) → handler` with `:param` segments (tech spec §5). */
import type { IncomingHttpHeaders } from 'node:http';

import { MAX_BODY_BYTES } from './constants.js';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface ParsedRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export type HandlerResult =
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly text: string; readonly contentType: string };

export type Handler = (req: ParsedRequest) => HandlerResult | Promise<HandlerResult>;

export type RouteMatch =
  | { readonly kind: 'found'; readonly handler: Handler; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: 'method_not_allowed'; readonly allowed: readonly string[] }
  | { readonly kind: 'not_found' };

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split('/'), handler });
  }

  /** Throws `HttpError(400)` for a malformed percent-encoding in a param. */
  match(method: string, pathname: string): RouteMatch {
    const parts = pathname.split('/');
    const allowed: string[] = [];

    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params === null) continue;
      if (route.method === method) return { kind: 'found', handler: route.handler, params };
      if (!allowed.includes(route.method)) allowed.push(route.method);
    }
    return allowed.length > 0 ? { kind: 'method_not_allowed', allowed } : { kind: 'not_found' };
  }
}

function matchSegments(pattern: readonly string[], parts: readonly string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of pattern.entries()) {
    const part = parts[i] ?? '';
    if (segment.startsWith(':')) {
      if (part === '') return null;
      params[segment.slice(1)] = decodeParam(part);
    } else if (segment !== part) {
      return null;
    }
  }
  return params;
}

function decodeParam(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'malformed percent-encoding in the request path');
  }
}

/** An empty body reads as `{}`. Oversized → 413, unparseable → 400. */
export async function readJsonBody(
  body: AsyncIterable<Buffer | string>,
  headers: IncomingHttpHeaders,
  limit = MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw tooLarge(limit);
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON');
  }
}

function tooLarge(limit: number): HttpError {
  return new HttpError(413, `the request body is larger than ${limit} bytes`);
}
