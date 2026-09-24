/**
 * The write API (tech spec §5, plan Phase 4). Each handler runs under the host's
 * mutex, calls the existing write path (`actions.ts`, `addFeature`) and maps what
 * it says; none reads an item's state to decide anything itself.
 */
import { addFeature, FeatureAddError } from '../../cli/featureAdd.js';
import type { FeatureAddRefusal, FeatureAddResult } from '../../cli/featureAdd.js';
import type { VaultScope } from '../../cli/resolve.js';
import { slugify } from '../../domain/ids.js';
import { ActionError, approve, clearKill, kill, reject } from '../../orchestrator/actions.js';
import { StartupRefused } from '../../orchestrator/host.js';
import { InstanceLockHeldError } from '../../orchestrator/lock.js';
import type { DashboardHost } from '../host.js';
import { HostStateError } from '../host.js';
import { HttpError } from '../router.js';
import type { HandlerResult, ParsedRequest, Router } from '../router.js';

export interface WriteContext {
  readonly scope: VaultScope;
  readonly host: Pick<
    DashboardHost,
    'mutex' | 'hosting' | 'lockView' | 'start' | 'requestStop' | 'wake'
  >;
}

export type WriteHandlers = Record<
  'approve' | 'reject' | 'addFeature' | 'start' | 'stop' | 'kill' | 'resume',
  (req: ParsedRequest) => Promise<HandlerResult>
>;

const REFUSAL_STATUS: Readonly<Record<FeatureAddRefusal, number>> = {
  priority: 400,
  slug: 400,
  duplicate: 409,
  in_progress: 409,
};

export function registerWriteRoutes(router: Router, ctx: WriteContext): void {
  const h = writeHandlers(ctx);
  router.add('POST', '/api/items/:id/approve', h.approve);
  router.add('POST', '/api/items/:id/reject', h.reject);
  router.add('POST', '/api/features', h.addFeature);
  router.add('POST', '/api/factory/start', h.start);
  router.add('POST', '/api/factory/stop', h.stop);
  router.add('POST', '/api/factory/kill', h.kill);
  router.add('POST', '/api/factory/resume', h.resume);
}

export function writeHandlers(ctx: WriteContext): WriteHandlers {
  const { scope, host } = ctx;

  return {
    async approve(req) {
      const id = req.params['id'] ?? '';
      const note = optionalString(bodyOf(req), 'note');
      return await host.mutex.run(async () => {
        const result = await conflictOnActionError(() => approve(scope.actionContext, id, note));
        host.wake();
        // The standing-approval route, detected exactly as `runApprove` detects it.
        const held = result.kind === 'feature' && result.to === 'awaiting_feature_close';
        return { status: 200, json: { ...result, held } };
      });
    },

    async reject(req) {
      const id = req.params['id'] ?? '';
      const reason = optionalString(bodyOf(req), 'reason') ?? '';
      if (reason.trim() === '') {
        throw new HttpError(
          400,
          'a rejection needs a reason: say what to change, because the next agent reads it',
        );
      }
      return await host.mutex.run(async () => {
        const result = await conflictOnActionError(() => reject(scope.actionContext, id, reason));
        host.wake();
        return { status: 200, json: result };
      });
    },

    async addFeature(req) {
      const body = bodyOf(req);
      const name = optionalString(body, 'name') ?? '';
      const requirement = optionalString(body, 'requirement') ?? '';
      const priority = optionalString(body, 'priority') ?? 'medium';
      if (name.trim() === '') throw new HttpError(400, 'a feature needs a name');
      if (requirement.trim() === '') throw new HttpError(400, 'a feature needs a requirement');

      return await host.mutex.run(async () => {
        let result: FeatureAddResult;
        try {
          result = await addFeature(
            { paths: scope.paths, storage: scope.storage, now: scope.actionContext.now },
            { slug: slugify(name), priority, requirement, title: name.trim() },
          );
        } catch (error) {
          if (error instanceof FeatureAddError) {
            throw new HttpError(REFUSAL_STATUS[error.reason], error.message);
          }
          throw error;
        }
        host.wake();
        return { status: 201, json: { id: result.id, slug: result.slug } };
      });
    },

    async start() {
      return await host.mutex.run(async (): Promise<HandlerResult> => {
        try {
          await host.start();
        } catch (error) {
          if (error instanceof StartupRefused) {
            return { status: 422, json: { message: error.message, failures: error.failures } };
          }
          if (error instanceof HostStateError || error instanceof InstanceLockHeldError) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
        return { status: 202, json: { mode: 'hosted' } };
      });
    },

    async stop(req) {
      const force = optionalBoolean(bodyOf(req), 'force') ?? false;
      return await host.mutex.run(async () => {
        if (!host.hosting) {
          const view = await host.lockView();
          throw new HttpError(
            409,
            view.mode === 'external'
              ? `The factory is running in another process (pid ${String(view.pid)}), not in this ` +
                  'dashboard. Stop it there with `factory stop`.'
              : 'The factory is not running in this dashboard.',
          );
        }
        try {
          host.requestStop({ force });
        } catch (error) {
          if (error instanceof HostStateError) throw new HttpError(409, error.message);
          throw error;
        }
        return { status: 202, json: { stopping: true, force } };
      });
    },

    async kill() {
      return await host.mutex.run(async () => {
        await kill(scope.paths, scope.actionContext.now, scope.storage);
        return { status: 200, json: { killed: true } };
      });
    },

    async resume() {
      return await host.mutex.run(async () => {
        await clearKill(scope.paths);
        host.wake();
        return { status: 200, json: { killed: false } };
      });
    },
  };
}

async function conflictOnActionError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ActionError) throw new HttpError(409, error.message);
    throw error;
  }
}

function bodyOf(req: ParsedRequest): Readonly<Record<string, unknown>> {
  const body = req.body;
  if (body === undefined) return {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'the request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function optionalString(body: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
  return value;
}

function optionalBoolean(body: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be true or false`);
  return value;
}
