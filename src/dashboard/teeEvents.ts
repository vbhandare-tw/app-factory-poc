/**
 * The hosted orchestrator's event sink (tech spec §4.2): every event is written
 * to `orchestrator.jsonl` first, then published on the bus.
 */
import type { EventSink, FactoryEvent } from '../log/events.js';
import type { BusEvent, ChangeBus } from './changeBus.js';
import { summariseEvent } from './labels.js';

export class TeeEventSink implements EventSink {
  private readonly inner: EventSink;
  private readonly bus: Pick<ChangeBus, 'emit'>;
  private lines = 0;

  constructor(inner: EventSink, bus: Pick<ChangeBus, 'emit'>) {
    this.inner = inner;
    this.bus = bus;
  }

  /** Lines written through this sink so far. */
  get written(): number {
    return this.lines;
  }

  /** Resolves and rejects exactly as the wrapped sink does; nothing on the bus side can fail it. */
  async emit(event: FactoryEvent): Promise<void> {
    await this.inner.emit(event);
    this.lines += 1;
    try {
      // Our own clock, never the log's: calling the orchestrator's `now` here
      // would shift every timestamp written after it (Section E item 6).
      const logged: BusEvent = { ts: new Date().toISOString(), ...event };
      this.bus.emit({ kind: 'event', event: logged, summary: summariseEvent(logged) });
    } catch {
      // The line is on disk, which is what matters; the feed can miss it.
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
