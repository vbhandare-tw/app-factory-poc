/**
 * `GET /api/stream[?run=<runId>]` (tech spec §5): the change bus as server-sent
 * events, plus one transcript's new steps when `run` names a run.
 */
import type { ChangeBus, ChangeMessage } from '../changeBus.js';
import { SSE_HEARTBEAT_MS } from '../constants.js';
import { HttpError } from '../router.js';
import type { HandlerResult, ParsedRequest, Router } from '../router.js';
import type { RunIndex } from '../runIndex.js';
import { liveLogPath } from '../security.js';
import type { TranscriptFollower } from '../watchers.js';

export interface StreamContext {
  readonly bus: ChangeBus;
  readonly runIndex: RunIndex;
  readonly logsDir: string;
  readonly transcripts: TranscriptFollower;
  readonly heartbeatMs?: number;
}

interface Frame {
  readonly event: string;
  readonly data: unknown;
}

export function registerStreamRoutes(router: Router, ctx: StreamContext): void {
  router.add('GET', '/api/stream', streamHandler(ctx));
}

export function streamHandler(ctx: StreamContext): (req: ParsedRequest) => Promise<HandlerResult> {
  const heartbeatMs = ctx.heartbeatMs ?? SSE_HEARTBEAT_MS;

  return async (req) => {
    const runId = req.query.get('run');
    const transcript = runId === null ? null : { runId, file: transcriptOf(ctx, runId) };

    return {
      status: 200,
      stream: (channel) => {
        const send = (frame: Frame): void => {
          channel.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        };
        const unsubscribe = ctx.bus.subscribe((message) => {
          const frame = frameOf(message, runId);
          if (frame !== null) send(frame);
        });
        const following = transcript === null ? null : ctx.transcripts.follow(transcript.runId, transcript.file);
        const heartbeat = setInterval(() => send({ event: 'heartbeat', data: {} }), heartbeatMs);
        channel.onClose(() => {
          clearInterval(heartbeat);
          unsubscribe();
          following?.release();
        });
        void (following?.ready ?? Promise.resolve()).then(() => channel.write(': connected\n\n'));
      },
    };
  };
}

function transcriptOf(ctx: StreamContext, runId: string): string {
  const run = ctx.runIndex.run(runId);
  const file = run === undefined ? null : liveLogPath(run.logPath, ctx.logsDir);
  if (file === null) throw new HttpError(404, `no run ${JSON.stringify(runId)} with a transcript in this vault`);
  return file;
}

function frameOf(message: ChangeMessage, runId: string | null): Frame | null {
  switch (message.kind) {
    case 'event':
      return { event: 'event', data: { event: message.event, summary: message.summary } };
    case 'state_changed':
      return { event: 'state_changed', data: { itemIds: message.itemIds } };
    case 'transcript_line':
      return message.runId === runId
        ? { event: 'transcript_line', data: { runId, firstLine: message.firstLine, steps: message.steps } }
        : null;
  }
}
