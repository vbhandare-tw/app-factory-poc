/**
 * The write API (tech spec §5, plan Phase 4) over a real fixture vault. Each
 * handler must call the one existing write path — `actions.ts` or
 * `addFeature` — and map what it says, under the host's mutex.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import type { VaultScope } from '../../../src/cli/resolve.js';
import { DASHBOARD_HOST } from '../../../src/dashboard/constants.js';
import { writeHandlers, registerWriteRoutes } from '../../../src/dashboard/handlers/write.js';
import { DashboardHost } from '../../../src/dashboard/host.js';
import type { DashboardHostOptions } from '../../../src/dashboard/host.js';
import { HttpError, Router } from '../../../src/dashboard/router.js';
import type { HandlerResult, ParsedRequest } from '../../../src/dashboard/router.js';
import { newSessionToken } from '../../../src/dashboard/security.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { sectionText } from '../../../src/domain/markdown.js';
import type { FeatureFrontmatter, Note, TicketFrontmatter } from '../../../src/domain/types.js';
import { ActionError, reject } from '../../../src/orchestrator/actions.js';
import { StartupRefused } from '../../../src/orchestrator/host.js';
import { MarkdownStorage } from '../../../src/vault/storage.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import {
  abortOf,
  deferred,
  fakeOrchestrator,
  scopeFor,
  settlesWithin,
  writeLockRecord,
} from '../../helpers/dashboardFixtures.js';
import type { FakeOrchestrator } from '../../helpers/dashboardFixtures.js';
import { factoryVault, readNoteFile } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const NOW = '2026-09-24T10:00:00.000Z';
const PAUSED_AT = '2026-09-24T09:00:00.000Z';
const FOREIGN_PID = 4_242_431;

let vault: FactoryFixture;
let fake: FakeOrchestrator;
let hosts: DashboardHost[];
let servers: http.Server[];

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

/** Writes are held back, so two unserialised approvals would both read `needs_human` first. */
class SlowStorage extends MarkdownStorage {
  override async writeNote<T>(file: string, note: Note<T>): Promise<void> {
    await new Promise((done) => setTimeout(done, 80));
    await super.writeNote(file, note);
  }
}

function host(scope: VaultScope = scopeFor(vault, { now: () => NOW }), overrides: Partial<DashboardHostOptions> = {}): DashboardHost {
  const created = new DashboardHost({
    scope,
    deps: { env: { PATH: process.env['PATH'] ?? '' }, now: () => NOW },
    startOrchestrator: fake.start,
    isAlive: (pid) => pid === FOREIGN_PID || pid === process.pid,
    log: () => undefined,
    ...overrides,
  });
  hosts.push(created);
  return created;
}

function post(params: Record<string, string> = {}, body: unknown = {}): ParsedRequest {
  return { method: 'POST', path: '/', params, query: new URLSearchParams(), body };
}

/** What the server would send: a handler result, or the `HttpError` it threw. */
async function reply(result: Promise<HandlerResult>): Promise<Reply> {
  try {
    const done = await result;
    if (!('json' in done)) throw new Error('expected a JSON result');
    return { status: done.status, json: done.json as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { status: error.status, json: { message: error.message } };
  }
}

async function feature(slug: string, overrides: Partial<FeatureFrontmatter> = {}): Promise<void> {
  mkdirSync(vault.paths.featureDir(slug), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.featureNote(slug),
    makeFeature({ id: `FEAT-${slug.toUpperCase()}`, slug, title: slug, ...overrides }),
  );
}

/** A feature parked at the refinement checkpoint, the way the loop leaves it. */
async function checkpoint(slug = 'alpha'): Promise<void> {
  await feature(slug, {
    status: 'needs_human',
    pause_reason: 'checkpoint',
    pause_detail: 'after_pm_refinement',
    resume_to: 'planning',
    reject_to: 'refining',
    paused_at: PAUSED_AT,
  });
}

function status(slug = 'alpha'): string {
  return readNoteFile(vault.paths.featureNote(slug)).frontmatter.status;
}

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, DASHBOARD_HOST, () => resolve((server.address() as AddressInfo).port));
  });
}

beforeEach(() => {
  vault = factoryVault();
  fake = fakeOrchestrator();
  hosts = [];
  servers = [];
});

afterEach(async () => {
  for (const h of hosts) await h.forceStop();
  for (const server of servers) {
    await new Promise<void>((done) => {
      if (!server.listening) return done();
      server.close(() => done());
      server.closeAllConnections();
    });
  }
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('approve', () => {
  it('on a checkpoint → 200, the note moves to resume_to, and the note text lands in ## Notes', async () => {
    await checkpoint();
    const h = host();

    const result = await reply(writeHandlers({ scope: h.scope, host: h }).approve(post({ id: 'FEAT-ALPHA' }, { note: 'keep the API shape' })));

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      id: 'FEAT-ALPHA',
      kind: 'feature',
      from: 'needs_human',
      to: 'planning',
      held: false,
    });
    const note = readNoteFile(vault.paths.featureNote('alpha'));
    expect(note.frontmatter.status).toBe('planning');
    expect(sectionText(note.body, SECTION.notes)).toContain('keep the API shape');
  });

  it('twice → the second returns 409 with the actions.ts message', async () => {
    await checkpoint();
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect((await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })))).status).toBe(200);
    const second = await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })));

    expect(second).toEqual({
      status: 409,
      json: {
        message:
          'FEAT-ALPHA is planning, not needs_human. There is nothing to approve — the factory only ' +
          'pauses for a human at a checkpoint or an escalation.',
      },
    });
  });

  it('works on an item that was parked after the dashboard last looked at it', async () => {
    await feature('alpha', { status: 'refining' });
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect((await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })))).status).toBe(409);

    await checkpoint();
    const result = await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })));
    expect(result.status).toBe(200);
    expect(status()).toBe('planning');
  });

  it('an unknown id → 409 naming what is waiting', async () => {
    await checkpoint();
    const h = host();
    const result = await reply(writeHandlers({ scope: h.scope, host: h }).approve(post({ id: 'FEAT-NOPE' })));
    expect(result).toEqual({
      status: 409,
      json: { message: 'no feature or ticket with id "FEAT-NOPE" in this vault. Waiting for you: FEAT-ALPHA.' },
    });
  });

  it('a note that is not a string → 400, and nothing is written', async () => {
    await checkpoint();
    const h = host();
    const result = await reply(writeHandlers({ scope: h.scope, host: h }).approve(post({ id: 'FEAT-ALPHA' }, { note: 42 })));
    expect(result.status).toBe(400);
    expect(status()).toBe('needs_human');
  });

  it('a body that is not a JSON object → 400', async () => {
    await checkpoint();
    const h = host();
    for (const body of [[], 'approve', 7, null]) {
      const result = await reply(writeHandlers({ scope: h.scope, host: h }).approve(post({ id: 'FEAT-ALPHA' }, body)));
      expect(result.status).toBe(400);
    }
    expect(status()).toBe('needs_human');
  });

  it('two concurrent approvals of the same id → exactly one 200 and one 409 (the mutex)', async () => {
    await checkpoint();
    const slow = new SlowStorage(vault.paths);
    const h = host(scopeFor(vault, { storage: slow, now: () => NOW }));
    const handlers = writeHandlers({ scope: h.scope, host: h });

    const results = await Promise.all([
      reply(handlers.approve(post({ id: 'FEAT-ALPHA' }, { note: 'first' }))),
      reply(handlers.approve(post({ id: 'FEAT-ALPHA' }, { note: 'second' }))),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.json['message']).toMatch(/^FEAT-ALPHA is planning, not needs_human\./);
    const notes = sectionText(readNoteFile(vault.paths.featureNote('alpha')).body, SECTION.notes) ?? '';
    expect(notes.match(/Approved by a human/g)).toHaveLength(1);
  });
});

describe('reject', () => {
  it('with an empty reason → 400, and nothing is written', async () => {
    await checkpoint();
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    for (const body of [{}, { reason: '' }, { reason: '   \n' }]) {
      expect((await reply(handlers.reject(post({ id: 'FEAT-ALPHA' }, body)))).status).toBe(400);
    }
    expect(status()).toBe('needs_human');
  });

  it('with a reason → 200 and reject_to, the reason in ## Notes', async () => {
    await checkpoint();
    const h = host();

    const result = await reply(
      writeHandlers({ scope: h.scope, host: h }).reject(post({ id: 'FEAT-ALPHA' }, { reason: 'handle negative numbers' })),
    );

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ id: 'FEAT-ALPHA', from: 'needs_human', to: 'refining' });
    const note = readNoteFile(vault.paths.featureNote('alpha'));
    expect(note.frontmatter.status).toBe('refining');
    expect(sectionText(note.body, SECTION.notes)).toContain('handle negative numbers');
  });

  it('on a pause with no reject_to → 409 with the actions.ts message', async () => {
    await feature('alpha', { status: 'in_development' });
    mkdirSync(vault.paths.ticketsDir('alpha'), { recursive: true });
    const ticket: Partial<TicketFrontmatter> = {
      id: 'FEAT-ALPHA-T001',
      feature: 'alpha',
      status: 'needs_human',
      pause_reason: 'attempts_exhausted',
      resume_to: 'ready',
      reject_to: null,
      paused_at: PAUSED_AT,
    };
    await vault.storage.writeNote(vault.paths.ticketPath('alpha', 'FEAT-ALPHA-T001'), makeTicket(ticket));
    const h = host();
    // The refusal fires before any write, so asking actions.ts directly changes nothing.
    const expected = await reject(h.scope.actionContext, 'FEAT-ALPHA-T001', 'try again').then(
      () => 'reject unexpectedly succeeded',
      (error: unknown) => (error instanceof ActionError ? error.message : String(error)),
    );
    expect(expected).toContain('and no reject_to');

    const result = await reply(
      writeHandlers({ scope: h.scope, host: h }).reject(post({ id: 'FEAT-ALPHA-T001' }, { reason: 'try again' })),
    );

    expect(result).toEqual({ status: 409, json: { message: expected } });
  });
});

describe('addFeature', () => {
  const REQUIREMENT = '# Expression calculator\n\nEvaluate `2 + 3 * 4` → 14.\n';

  it('→ 201 with the id and slug, and the requirement stored verbatim in intake', async () => {
    const h = host();

    const result = await reply(
      writeHandlers({ scope: h.scope, host: h }).addFeature(
        post({}, { name: 'Expression calculator', priority: 'high', requirement: REQUIREMENT }),
      ),
    );

    expect(result).toEqual({ status: 201, json: { id: 'FEAT-EXPRESSION-CALCULATOR', slug: 'expression-calculator' } });
    const note = readNoteFile(vault.paths.featureNote('expression-calculator'));
    expect(note.frontmatter).toMatchObject({
      id: 'FEAT-EXPRESSION-CALCULATOR',
      title: 'Expression calculator',
      status: 'intake',
      priority: 'high',
    });
    expect(sectionText(note.body, SECTION.rawRequirement)).toContain('Evaluate `2 + 3 * 4` → 14.');
  });

  it('defaults the priority to medium', async () => {
    const h = host();
    await reply(writeHandlers({ scope: h.scope, host: h }).addFeature(post({}, { name: 'alpha', requirement: 'x' })));
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter).toMatchObject({ priority: 'medium' });
  });

  it('a duplicate → 409 naming the existing feature', async () => {
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });
    await reply(handlers.addFeature(post({}, { name: 'alpha', requirement: 'x' })));

    const result = await reply(handlers.addFeature(post({}, { name: 'Alpha', requirement: 'y' })));

    expect(result.status).toBe(409);
    expect(result.json['message']).toMatch(/^FEAT-ALPHA \(alpha\) is already in this vault/);
  });

  it('while another feature is active → 409 with the A9 message, and nothing is written', async () => {
    await checkpoint('alpha');
    const h = host();

    const result = await reply(writeHandlers({ scope: h.scope, host: h }).addFeature(post({}, { name: 'bravo', requirement: 'x' })));

    expect(result).toEqual({
      status: 409,
      json: {
        message:
          'FEAT-ALPHA is still in progress (needs_human). The factory builds one feature at a time until M4; ' +
          'finish it first.',
      },
    });
    expect(existsSync(vault.paths.featureNote('bravo'))).toBe(false);
  });

  it.each([
    ['an empty name', { name: '  ', requirement: 'x' }],
    ['a missing name', { requirement: 'x' }],
    ['a name with no usable characters', { name: '!!!', requirement: 'x' }],
    ['an empty requirement', { name: 'alpha', requirement: ' \n ' }],
    ['a priority outside high/medium/low', { name: 'alpha', requirement: 'x', priority: 'urgent' }],
    ['a name that is not a string', { name: ['alpha'], requirement: 'x' }],
  ])('%s → 400, and nothing is written', async (_label, body) => {
    const h = host();
    const result = await reply(writeHandlers({ scope: h.scope, host: h }).addFeature(post({}, body)));
    expect(result.status).toBe(400);
    expect(existsSync(vault.paths.featureNote('alpha'))).toBe(false);
  });
});

describe('wake', () => {
  it('every successful approve, reject, addFeature and resume calls host.wake() once', async () => {
    await checkpoint('alpha');
    const h = host();
    const wake = vi.spyOn(h, 'wake');
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect((await reply(handlers.reject(post({ id: 'FEAT-ALPHA' }, { reason: 'narrow it' })))).status).toBe(200);
    expect(wake).toHaveBeenCalledTimes(1);

    await checkpoint('alpha');
    expect((await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })))).status).toBe(200);
    expect(wake).toHaveBeenCalledTimes(2);

    await feature('alpha', { status: 'done' });
    expect((await reply(handlers.addFeature(post({}, { name: 'bravo', requirement: 'x' })))).status).toBe(201);
    expect(wake).toHaveBeenCalledTimes(3);

    expect((await reply(handlers.resume(post()))).status).toBe(200);
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it('a failed write does not call it', async () => {
    await feature('alpha', { status: 'refining' });
    const h = host();
    const wake = vi.spyOn(h, 'wake');
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect((await reply(handlers.approve(post({ id: 'FEAT-ALPHA' })))).status).toBe(409);
    expect((await reply(handlers.reject(post({ id: 'FEAT-ALPHA' }, { reason: 'x' })))).status).toBe(409);
    expect((await reply(handlers.reject(post({ id: 'FEAT-ALPHA' }, {})))).status).toBe(400);
    expect((await reply(handlers.addFeature(post({}, { name: 'bravo', requirement: 'x' })))).status).toBe(409);
    expect(wake).not.toHaveBeenCalled();
  });
});

describe('kill and resume', () => {
  it('kill drops the kill switch; resume removes it', async () => {
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect(await reply(handlers.kill(post()))).toEqual({ status: 200, json: { killed: true } });
    expect(existsSync(vault.paths.killFile())).toBe(true);
    expect(readFileSync(vault.paths.killFile(), 'utf8')).toContain('Written by `factory kill`');

    expect(await reply(handlers.resume(post()))).toEqual({ status: 200, json: { killed: false } });
    expect(existsSync(vault.paths.killFile())).toBe(false);
  });
});

describe('start and stop', () => {
  it('start → 202 hosted; a second start → 409', async () => {
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    expect(await reply(handlers.start(post()))).toEqual({ status: 202, json: { mode: 'hosted' } });
    expect(await h.mode()).toBe('hosted');
    expect((await reply(handlers.start(post()))).status).toBe(409);
    expect(fake.inputs).toHaveLength(1);
  });

  it('start refused by startup validation → 422 with the failures', async () => {
    const failures = [{ code: 'target_repo_missing' as const, key: 'target_repo', message: 'gone' }];
    fake.behaviour.refuse = new StartupRefused('startup validation failed (1 problem)', failures);
    const h = host();

    const result = await reply(writeHandlers({ scope: h.scope, host: h }).start(post()));

    expect(result).toEqual({ status: 422, json: { message: 'startup validation failed (1 problem)', failures } });
    expect(await h.mode()).toBe('stopped');
  });

  it('start and stop in external mode → 409, and startOrchestrator is never called', async () => {
    writeLockRecord(vault, { pid: FOREIGN_PID });
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });

    const start = await reply(handlers.start(post()));
    const stop = await reply(handlers.stop(post()));

    expect(start.status).toBe(409);
    expect(start.json['message']).toContain(String(FOREIGN_PID));
    expect(stop.status).toBe(409);
    expect(stop.json['message']).toContain(String(FOREIGN_PID));
    expect(fake.inputs).toHaveLength(0);
  });

  it('stop with nothing hosted → 409', async () => {
    const h = host();
    const result = await reply(writeHandlers({ scope: h.scope, host: h }).stop(post()));
    expect(result).toEqual({ status: 409, json: { message: 'The factory is not running in this dashboard.' } });
  });

  it('stop → 202 at once while the run drains, and other writes are not held behind it', async () => {
    const release = deferred();
    fake.behaviour.run = async () => {
      await release.promise;
    };
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });
    await reply(handlers.start(post()));

    const stop = await reply(handlers.stop(post()));
    expect(stop).toEqual({ status: 202, json: { stopping: true, force: false } });
    expect(h.hosting).toBe(true);
    expect(h.status().stopping).toBe(true);

    // The mutex is free again: a write does not wait for the agent run to finish.
    expect(await settlesWithin(handlers.resume(post()), 500)).toBe(true);
    expect(h.hosting).toBe(true);

    release.resolve();
    await h.idle();
    expect(await h.mode()).toBe('stopped');
  });

  it('stop with force: true aborts the running agent', async () => {
    fake.behaviour.run = ({ input }) => abortOf(input.signal);
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });
    await reply(handlers.start(post()));

    expect(await reply(handlers.stop(post({}, { force: true })))).toEqual({
      status: 202,
      json: { stopping: true, force: true },
    });
    await h.idle();
    expect(fake.inputs[0]!.signal?.aborted).toBe(true);
    expect(await h.mode()).toBe('stopped');
  });

  it('stop with a force that is not a boolean → 400', async () => {
    const h = host();
    const handlers = writeHandlers({ scope: h.scope, host: h });
    await reply(handlers.start(post()));
    expect((await reply(handlers.stop(post({}, { force: 'yes' })))).status).toBe(400);
    expect(h.status().stopping).toBe(false);
  });
});

describe('over HTTP', () => {
  it('a POST without X-Factory-Token → 403 before any handler runs', async () => {
    await checkpoint();
    const h = host();
    const wake = vi.spyOn(h, 'wake');
    const router = new Router();
    registerWriteRoutes(router, { scope: h.scope, host: h });
    const port = await listen(createDashboardServer({ token: newSessionToken(), router }));

    const status403 = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: DASHBOARD_HOST,
          port,
          method: 'POST',
          path: '/api/items/FEAT-ALPHA/approve',
          headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', connection: 'close' },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });

    expect(status403).toBe(403);
    expect(status()).toBe('needs_human');
    expect(wake).not.toHaveBeenCalled();
  });
});
