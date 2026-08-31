import { describe, expect, it } from 'vitest';

import { featureId, runId, slugify, ticketId } from '../../../src/domain/ids.js';

/**
 * IDs appear in filenames, branch names, worktree paths and lock keys. A
 * collision or an unsanitised character corrupts something on disk.
 */
describe('featureId', () => {
  it("featureId('user-auth') -> FEAT-USER-AUTH", () => {
    expect(featureId('user-auth')).toBe('FEAT-USER-AUTH');
  });

  it('collapses spaces, punctuation and repeated separators to a single -', () => {
    expect(featureId('User  auth!!  --  v2')).toBe('FEAT-USER-AUTH-V2');
    expect(featureId('  leading and trailing  ')).toBe('FEAT-LEADING-AND-TRAILING');
    expect(featureId('a__b..c//d')).toBe('FEAT-A-B-C-D');
    expect(featureId('emoji 🚀 rocket')).toBe('FEAT-EMOJI-ROCKET');
  });

  it('is idempotent — feeding an id back in returns the same id', () => {
    expect(featureId(featureId('user-auth'))).toBe('FEAT-USER-AUTH');
  });

  it('is deterministic across calls', () => {
    expect(featureId('Some Feature')).toBe(featureId('Some Feature'));
  });

  it('rejects a slug with no usable characters', () => {
    expect(() => featureId('   ')).toThrow(/no usable characters/i);
    expect(() => featureId('!!!')).toThrow(/no usable characters/i);
    expect(() => featureId('')).toThrow(/no usable characters/i);
  });

  it('produces only characters that are safe in a filename and a git ref', () => {
    const id = featureId('Weird / name: with "quotes" and ~tilde^');
    expect(id).toMatch(/^FEAT-[A-Z0-9-]+$/);
  });
});

describe('slugify', () => {
  it('produces a lowercase kebab slug', () => {
    expect(slugify('User Auth v2')).toBe('user-auth-v2');
    expect(slugify('  Multi   space  ')).toBe('multi-space');
  });

  it('agrees with featureId', () => {
    expect(featureId('User Auth v2')).toBe(`FEAT-${slugify('User Auth v2').toUpperCase()}`);
  });
});

describe('ticketId', () => {
  it('zero-pads to three digits', () => {
    expect(ticketId('FEAT-USER-AUTH', 1)).toBe('FEAT-USER-AUTH-T001');
    expect(ticketId('FEAT-USER-AUTH', 42)).toBe('FEAT-USER-AUTH-T042');
    expect(ticketId('FEAT-USER-AUTH', 999)).toBe('FEAT-USER-AUTH-T999');
  });

  it('rolls past 999 without colliding with any earlier id', () => {
    expect(ticketId('F', 1000)).toBe('F-T1000');
    expect(ticketId('F', 1000)).not.toBe(ticketId('F', 100));
    const ids = new Set(
      Array.from({ length: 1200 }, (_unused, index) => ticketId('F', index + 1)),
    );
    expect(ids.size).toBe(1200);
  });

  it('rejects a non-positive or non-integer ordinal', () => {
    expect(() => ticketId('F', 0)).toThrow(/ordinal/i);
    expect(() => ticketId('F', -1)).toThrow(/ordinal/i);
    expect(() => ticketId('F', 1.5)).toThrow(/ordinal/i);
    expect(() => ticketId('F', Number.NaN)).toThrow(/ordinal/i);
  });

  it('rejects an empty feature id', () => {
    expect(() => ticketId('', 1)).toThrow(/feature id/i);
  });
});

describe('runId', () => {
  it('is stable — identical inputs produce identical output across calls', () => {
    const a = runId('FEAT-USER-AUTH-T001', 'developer', 2, 7);
    const b = runId('FEAT-USER-AUTH-T001', 'developer', 2, 7);
    expect(a).toBe(b);
    expect(a).toBe('FEAT-USER-AUTH-T001-developer-a2-7');
  });

  it('changes when any single input changes', () => {
    const base = runId('T', 'developer', 1, 1);
    expect(runId('U', 'developer', 1, 1)).not.toBe(base);
    expect(runId('T', 'qa', 1, 1)).not.toBe(base);
    expect(runId('T', 'developer', 2, 1)).not.toBe(base);
    expect(runId('T', 'developer', 1, 2)).not.toBe(base);
  });

  it('is safe as a filename — no separators or spaces', () => {
    expect(runId('FEAT-X-T001', 'code_reviewer', 0, 0)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a negative or non-integer attempt or counter', () => {
    expect(() => runId('T', 'pm', -1, 0)).toThrow(/attempt/i);
    expect(() => runId('T', 'pm', 0, -1)).toThrow(/counter/i);
    expect(() => runId('T', 'pm', 1.5, 0)).toThrow(/attempt/i);
  });

  it('rejects an empty item id', () => {
    expect(() => runId('', 'pm', 0, 0)).toThrow(/item id/i);
  });
});
