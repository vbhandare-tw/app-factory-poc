/**
 * Stream-json transcripts → plain-language steps (tech spec §5).
 * Shapes verified against `test/fixtures/transcripts/`, not spec prose.
 */
import { STRUCTURED_OUTPUT_TOOL } from '../runner/streamParse.js';
import { TOOL_RESULT_PREVIEW_CHARS } from './constants.js';

export type TranscriptStep =
  | { readonly kind: 'start'; readonly model: string; readonly tools: readonly string[] }
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'think'; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly summary: string; readonly input: unknown }
  | { readonly kind: 'tool_result'; readonly id: string; readonly ok: boolean; readonly preview: string; readonly truncated: boolean }
  | { readonly kind: 'deliver'; readonly attempt: number }
  | {
      readonly kind: 'end';
      readonly ok: boolean;
      readonly costUsd?: number;
      readonly durationMs?: number;
      readonly turns?: number;
      readonly reason?: string;
    }
  | { readonly kind: 'unknown'; readonly raw: string };

type JsonRecord = Record<string, unknown>;

/** What the lines read so far leave for the next chunk of the same transcript. */
export interface StepCarry {
  /** StructuredOutput calls so far, so `deliver` numbering runs on. */
  readonly deliveries: number;
  /** Their tool_use ids, so each one's echoed `tool_result` stays hidden. */
  readonly deliveryIds: ReadonlySet<string>;
}

export const FRESH_STEP_CARRY: StepCarry = { deliveries: 0, deliveryIds: new Set() };

export interface StepsAndCarry {
  readonly steps: TranscriptStep[];
  readonly carry: StepCarry;
}

/** Turn one agent transcript (already split into lines) into display steps. */
export function toSteps(lines: readonly string[]): TranscriptStep[];
/** The next chunk of a transcript: continue from `carry`, and return the carry after these lines. */
export function toSteps(lines: readonly string[], carry: StepCarry): StepsAndCarry;
export function toSteps(lines: readonly string[], carry?: StepCarry): TranscriptStep[] | StepsAndCarry {
  const result = stepsFrom(lines, carry ?? FRESH_STEP_CARRY);
  return carry === undefined ? result.steps : result;
}

function stepsFrom(lines: readonly string[], carry: StepCarry): StepsAndCarry {
  const steps: TranscriptStep[] = [];
  // Ids of StructuredOutput tool_use calls, so their own tool_result — always
  // "Structured output provided successfully" — is skipped rather than shown
  // twice: once as the numbered `deliver` step and again as a `tool_result`.
  const deliveryIds = new Set<string>(carry.deliveryIds);
  let deliveries = carry.deliveries;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    const event = parseLine(line);
    if (event === null) {
      steps.push({ kind: 'unknown', raw: line });
      continue;
    }

    switch (event['type']) {
      case 'system':
        if (event['subtype'] === 'init') {
          steps.push({
            kind: 'start',
            model: stringOr(event['model'], ''),
            tools: stringArrayOr(event['tools']),
          });
        }
        // Other subtypes (thinking_tokens, permission_denied, ...) have no
        // reader-facing content and are deliberately skipped, not unknown.
        break;
      case 'assistant':
        for (const block of contentBlocks(event)) {
          if (block['type'] === 'tool_use' && block['name'] === STRUCTURED_OUTPUT_TOOL) {
            const id = stringOr(block['id'], '');
            if (id.length > 0) deliveryIds.add(id);
            deliveries += 1;
            steps.push({ kind: 'deliver', attempt: deliveries });
          } else {
            pushAssistantBlock(steps, block);
          }
        }
        break;
      case 'user':
        for (const block of contentBlocks(event)) {
          pushUserBlock(steps, block, deliveryIds);
        }
        break;
      case 'result':
        steps.push(endStep(event));
        break;
      case 'rate_limit_event':
        // Usage telemetry, not a step in the agent's work.
        break;
      default:
        steps.push({ kind: 'unknown', raw: line });
    }
  }

  return { steps, carry: { deliveries, deliveryIds } };
}

/** The one-line summary shown next to a tool call (tech spec §5). */
export function summariseTool(name: string, input: unknown): string {
  const record = asRecord(input);
  switch (name) {
    case 'Read':
      return `Read ${stringOr(record['file_path'], '(unknown file)')}`;
    case 'Bash':
      return `Ran ${stringOr(record['command'], '(unknown command)')}`;
    case 'Edit':
    case 'Write':
      return `Edited ${stringOr(record['file_path'], '(unknown file)')}`;
    case 'Grep':
    case 'Glob':
      return `Searched ${stringOr(record['pattern'], '(unknown pattern)')}`;
    default:
      return name;
  }
}

/**
 * A page of raw lines: the `size` lines before `before` (a line index), or
 * the last `size` lines when `before` is omitted.
 */
export function pageLines(lines: readonly string[], before: number | undefined, size: number): readonly string[] {
  const end = before === undefined ? lines.length : Math.max(0, Math.min(before, lines.length));
  const start = Math.max(0, end - size);
  return lines.slice(start, end);
}

function pushAssistantBlock(steps: TranscriptStep[], block: JsonRecord): void {
  switch (block['type']) {
    case 'text': {
      steps.push({ kind: 'say', text: stringOr(block['text'], '') });
      return;
    }
    case 'thinking': {
      // The CLI redacts extended-thinking content to an encrypted `signature`
      // and an empty `thinking` string; the step still marks that the agent
      // thought, even with nothing readable to show.
      steps.push({ kind: 'think', text: stringOr(block['thinking'], stringOr(block['text'], '')) });
      return;
    }
    case 'tool_use': {
      const id = stringOr(block['id'], '');
      const name = stringOr(block['name'], '');
      const input = block['input'];
      steps.push({ kind: 'tool', id, name, summary: summariseTool(name, input), input });
      return;
    }
    default:
      steps.push({ kind: 'unknown', raw: JSON.stringify(block) });
  }
}

function pushUserBlock(steps: TranscriptStep[], block: JsonRecord, deliveryIds: ReadonlySet<string>): void {
  if (block['type'] !== 'tool_result') {
    steps.push({ kind: 'unknown', raw: JSON.stringify(block) });
    return;
  }
  const id = stringOr(block['tool_use_id'], '');
  if (deliveryIds.has(id)) return;

  const text = toolResultText(block['content']);
  const truncated = text.length > TOOL_RESULT_PREVIEW_CHARS;
  steps.push({
    kind: 'tool_result',
    id,
    ok: block['is_error'] !== true,
    preview: truncated ? text.slice(0, TOOL_RESULT_PREVIEW_CHARS) : text,
    truncated,
  });
}

function endStep(event: JsonRecord): TranscriptStep {
  const reason = stringOr(event['terminal_reason'], '') || stringOr(event['subtype'], '') || undefined;
  return {
    kind: 'end',
    ok: event['is_error'] !== true,
    costUsd: numberOrUndef(event['total_cost_usd']),
    durationMs: numberOrUndef(event['duration_ms']),
    turns: numberOrUndef(event['num_turns']),
    reason,
  };
}

/** `tool_result.content`: a plain string in every recorded run, or an array of `{type:'text'}` parts. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        return record['type'] === 'text' ? stringOr(record['text'], '') : '';
      })
      .join('');
  }
  return '';
}

function contentBlocks(event: JsonRecord): readonly JsonRecord[] {
  const message = asRecord(event['message']);
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is JsonRecord => isRecord(block));
}

function parseLine(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArrayOr(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function numberOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
