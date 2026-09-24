/** The page's single state object, and the pure rules for merging live data into it. */

export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const changed = Object.keys(patch).filter((key) => !Object.is(state[key], patch[key]));
      if (changed.length === 0) return;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) {
        try {
          listener(state, changed);
        } catch (error) {
          console.error('dashboard: a store subscriber failed', error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function selectWaitingCount(state) {
  const items = state?.status?.needs_human ?? [];
  return items.filter((item) => item.status === 'needs_human').length;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** An event's identity without `ts`: a live event's ts is wall-clock, the logged copy's is not. */
export function eventKey(event) {
  const { ts: _ts, summary: _summary, ...rest } = event;
  return stable(rest);
}

/**
 * `fetched` is newest first; `pending` are live events heard during the fetch, oldest first.
 * Only the newest `pending.length` fetched events can be those same events.
 */
export function mergeActivity(fetched, pending, limit) {
  const overlap = new Set(fetched.slice(0, pending.length).map(eventKey));
  const fresh = pending.filter((event) => !overlap.has(eventKey(event)));
  return [...fresh.reverse(), ...fetched].slice(0, limit);
}

/**
 * A live chunk starting at `firstLine`: append it if contiguous with what is shown,
 * else reload the page ending where it starts (one follower's chunks are contiguous).
 */
export function planChunk(sync, firstLine) {
  const contiguous = sync.mode === 'page' ? firstLine === sync.lastLine : firstLine > sync.lastFirst;
  return contiguous
    ? { action: 'append', next: { mode: 'live', lastFirst: firstLine } }
    : { action: 'resync', before: firstLine };
}

/**
 * `refresh()` loads now and hands the result to `apply(value, error)`; calls during a load
 * queue exactly one more, run after it. No timers: hidden tabs throttle them, and short runs were missed.
 */
export function createRefresher(load, apply) {
  let running = null;
  let again = false;
  return function refresh() {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          let value = null;
          let failure = null;
          try {
            value = await load();
          } catch (error) {
            failure = error;
          }
          apply(value, failure);
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
