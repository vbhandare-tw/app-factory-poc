import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES } from '../../../src/dashboard/constants.js';
import { HttpError, Router, readJsonBody } from '../../../src/dashboard/router.js';

function router(): Router {
  const r = new Router();
  r.add('GET', '/api/state', () => ({ status: 200, json: 'state' }));
  r.add('GET', '/api/features/:slug', () => ({ status: 200, json: 'feature' }));
  r.add('GET', '/api/runs/:runId/transcript', () => ({ status: 200, json: 'transcript' }));
  r.add('POST', '/api/items/:id/approve', () => ({ status: 200, json: 'approve' }));
  return r;
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return undefined;
}

describe('Router.match', () => {
  it('matches a static path', () => {
    const match = router().match('GET', '/api/state');
    expect(match.kind).toBe('found');
  });

  it('extracts a :param', () => {
    const match = router().match('GET', '/api/features/alpha');
    expect(match).toMatchObject({ kind: 'found', params: { slug: 'alpha' } });
  });

  it('extracts a :param in the middle of a pattern', () => {
    const match = router().match('GET', '/api/runs/FEAT-X-pm-a1-1/transcript');
    expect(match).toMatchObject({ kind: 'found', params: { runId: 'FEAT-X-pm-a1-1' } });
  });

  it('percent-decodes a param, so the handler validates what the client meant', () => {
    const match = router().match('GET', '/api/features/..%2F..%2Fetc');
    expect(match).toMatchObject({ kind: 'found', params: { slug: '../../etc' } });
  });

  it('rejects a malformed percent-encoding with 400', () => {
    expect(statusOf(() => router().match('GET', '/api/features/%E0%A4%A'))).toBe(400);
  });

  it('returns not_found for an unknown path', () => {
    expect(router().match('GET', '/api/nope').kind).toBe('not_found');
  });

  it('returns not_found for an empty param or a trailing slash', () => {
    expect(router().match('GET', '/api/features/').kind).toBe('not_found');
    expect(router().match('GET', '/api/features/alpha/').kind).toBe('not_found');
  });

  it('returns not_found for extra segments', () => {
    expect(router().match('GET', '/api/features/alpha/extra/more').kind).toBe('not_found');
  });

  it('returns method_not_allowed, with the allowed methods, for a known path', () => {
    expect(router().match('POST', '/api/state')).toEqual({
      kind: 'method_not_allowed',
      allowed: ['GET'],
    });
    expect(router().match('GET', '/api/items/X/approve')).toEqual({
      kind: 'method_not_allowed',
      allowed: ['POST'],
    });
  });
});

describe('readJsonBody', () => {
  const stream = (chunks: readonly string[]): Readable => Readable.from(chunks.map((c) => Buffer.from(c)));

  it('parses a JSON body', async () => {
    await expect(readJsonBody(stream(['{"note":', '"ok"}']), {})).resolves.toEqual({ note: 'ok' });
  });

  it('treats an empty body as an empty object', async () => {
    await expect(readJsonBody(stream([]), {})).resolves.toEqual({});
  });

  it('rejects invalid JSON with 400', async () => {
    await expect(readJsonBody(stream(['{not json']), {})).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a body over 1 MB with 413, while streaming', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const chunks = Array.from({ length: Math.ceil(MAX_BODY_BYTES / chunk.length) + 1 }, () => chunk);
    await expect(readJsonBody(stream(chunks), {})).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a declared Content-Length over 1 MB with 413 before reading', async () => {
    await expect(
      readJsonBody(stream(['{}']), { 'content-length': String(MAX_BODY_BYTES + 1) }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('accepts a body of exactly 1 MB', async () => {
    const body = JSON.stringify('x'.repeat(MAX_BODY_BYTES - 2));
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    await expect(readJsonBody(stream([body]), {})).resolves.toHaveLength(MAX_BODY_BYTES - 2);
  });
});
