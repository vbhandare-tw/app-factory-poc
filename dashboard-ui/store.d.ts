export interface Store<S extends object> {
  get(): S;
  set(patch: Partial<S>): void;
  subscribe(listener: (state: S, changed: string[]) => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S>;

export function selectWaitingCount(state: {
  status?: { needs_human?: readonly ({ status: string } & Record<string, unknown>)[] } | null;
}): number;

export type ActivityEvent = { type: string; ts?: string; summary: string } & Record<string, unknown>;

export function eventKey(event: ActivityEvent): string;
export function mergeActivity(fetched: readonly ActivityEvent[], pending: readonly ActivityEvent[], limit: number): ActivityEvent[];

export type ChunkSync = { mode: 'page'; lastLine: number } | { mode: 'live'; lastFirst: number };
export type ChunkPlan = { action: 'append'; next: ChunkSync } | { action: 'resync'; before: number };

export function planChunk(sync: ChunkSync, firstLine: number): ChunkPlan;

export function createRefresher<T>(load: () => Promise<T>, apply: (value: T | null, error: unknown) => void): () => Promise<void>;
