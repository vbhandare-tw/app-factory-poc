export type Tone = 'waiting' | 'failed' | 'done' | 'running' | 'idle' | 'neutral';

export const STAGE_LABELS: Readonly<Record<string, string>>;
export const ROLE_LABELS: Readonly<Record<string, string>>;
export const PAUSE_REASON_LABELS: Readonly<Record<string, string>>;
export const TICKET_COLUMNS: readonly string[];
export const FEATURE_STRIP: readonly string[];
export const TONES: readonly Tone[];

export function stageLabel(stage: string | null | undefined): string;
export function roleLabel(role: string | null | undefined): string;
export function pauseLabel(reason: string | null | undefined): string;
export function actorLabel(actor: string | null | undefined): string;
export function stageClass(stage: string | null | undefined): `tone-${Tone}`;
export function money(usd: number | null | undefined): string;
export function duration(ms: number | null | undefined): string;
export function relativeTime(iso: string | null | undefined, nowMs?: number): string;
export function clockTime(iso: string | null | undefined): string;
export function parseRunId(runId: string | null | undefined): { itemId: string; role: string; attempt: number } | null;
export function stripPosition(
  status: string | null | undefined,
  resumeTo: string | null | undefined,
  pauseReason: string | null | undefined,
): { at: number; waiting: boolean };
export function cwdFromInitLine(line: string | null | undefined): string | null;
export function relativizePaths(text: string | null | undefined, cwd: string | null | undefined): string;
export function isRoutineEvent(event: { type: string } & Record<string, unknown>): boolean;
