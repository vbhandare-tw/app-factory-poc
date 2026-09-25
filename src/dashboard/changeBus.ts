/** Fan-out from every change source to every SSE client (tech spec §4.2). */
import type { TranscriptStep } from './transcriptView.js';

/** A logged event as it reached the dashboard: the tee's own, or a line read from the file. */
export type BusEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export type ChangeMessage =
  | { readonly kind: 'event'; readonly event: BusEvent; readonly summary: string }
  | { readonly kind: 'state_changed'; readonly itemIds: readonly string[] }
  | {
      readonly kind: 'transcript_line';
      readonly runId: string;
      /** Index, from 0, of the chunk's first transcript line; that line may itself show no step. */
      readonly firstLine: number;
      readonly steps: readonly TranscriptStep[];
    };

export type ChangeListener = (message: ChangeMessage) => void;

export interface ChangeBusOptions {
  /** A listener threw; the others still got the message. */
  readonly onError?: (error: unknown) => void;
}

interface Subscription {
  readonly listener: ChangeListener;
}

export class ChangeBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly onError: (error: unknown) => void;

  constructor(options: ChangeBusOptions = {}) {
    this.onError = options.onError ?? ((): void => undefined);
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** Listeners hear messages in the order they subscribed. Returns an idempotent unsubscribe. */
  subscribe(listener: ChangeListener): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  emit(message: ChangeMessage): void {
    for (const subscription of [...this.subscriptions]) {
      if (!this.subscriptions.has(subscription)) continue;
      try {
        subscription.listener(message);
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
