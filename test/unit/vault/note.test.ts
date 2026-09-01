import { describe, expect, it } from 'vitest';

import type { FeatureFrontmatter, TicketFrontmatter } from '../../../src/domain/types.js';
import { FRONTMATTER_ORDER, NoteParseError, parseNote, serializeNote } from '../../../src/vault/note.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import { HOSTILE_BODY, HOSTILE_VALUES, RAW_CORPUS } from '../../helpers/vaultFixtures.js';

/**
 * Compile-time proof that `FRONTMATTER_ORDER` names every field the domain
 * layer declares. Phase 2 inferred the frontmatter field set; this is the first
 * phase that writes it to disk, so a field missing here would silently fall
 * into the "unknown key" bucket and be emitted out of order forever.
 *
 * If this stops compiling, the tuple in `src/vault/note.ts` is out of date.
 */
type OrderedKey = (typeof FRONTMATTER_ORDER)[number];
type UnorderedDomainKey = Exclude<
  keyof FeatureFrontmatter | keyof TicketFrontmatter,
  OrderedKey
>;
type OrderedKeyWithNoDomainField = Exclude<
  OrderedKey,
  keyof FeatureFrontmatter | keyof TicketFrontmatter
>;

export const FRONTMATTER_ORDER_COVERS_DOMAIN: [UnorderedDomainKey] extends [never]
  ? true
  : ['FRONTMATTER_ORDER is missing', UnorderedDomainKey] = true;

export const FRONTMATTER_ORDER_HAS_NO_STRAYS: [OrderedKeyWithNoDomainField] extends [never]
  ? true
  : ['FRONTMATTER_ORDER names a field no frontmatter type has', OrderedKeyWithNoDomainField] =
  true;

/**
 * The top-level frontmatter keys of a serialized note, in the order they appear.
 *
 * A regex, and deliberately a test-only one: it exists to read the emitter's
 * output back without going through the emitter's own parser, so a bug that
 * affected both could not hide. Nested mappings are indented, so anchoring at
 * column zero is enough to skip them.
 */
function frontmatterKeyOrder(serialized: string): string[] {
  const end = serialized.indexOf('\n---\n', 3);
  const block = serialized.slice(4, end === -1 ? undefined : end + 1);

  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_][A-Za-z0-9_ -]*|"[^"]*"):(\s|$)/.exec(line);
    if (match?.[1] !== undefined) keys.push(match[1].replace(/^"|"$/g, ''));
  }
  return keys;
}

const CANONICAL_FEATURE = [
  '---',
  'type: "feature"',
  'id: "FEAT-USER-AUTH"',
  'title: "User authentication"',
  'status: "refining"',
  'slug: "user-auth"',
  'priority: "high"',
  'attempts: 0',
  'cost_usd: 0',
  'feature_branch: null',
  'tag: null',
  'created_at: "2026-08-31T10:00:00Z"',
  'updated_at: "2026-08-31T10:05:00Z"',
  'locked_by: null',
  'locked_at: null',
  'pause_reason: null',
  'pause_detail: null',
  'resume_to: null',
  'reject_to: null',
  'paused_at: null',
  '---',
  '',
  '## Raw Requirement',
  '',
  'Let people sign in.',
  '',
  '## History',
  '',
  '- 2026-08-31T10:05:00Z | intake → refining | orchestrator',
  '',
].join('\n');

const CANONICAL_TICKET = [
  '---',
  'type: "ticket"',
  'id: "FEAT-USER-AUTH-T001"',
  'title: "Add the login form"',
  'status: "gates"',
  'feature: "user-auth"',
  'ordinal: 1',
  'depends_on: []',
  'attempts: 1',
  'max_attempts: null',
  'cost_usd: 0.42',
  'branch: "feat/user-auth/t001-add-the-login-form"',
  'worktree: null',
  'gate_results:',
  '  tests:',
  '    status: "pass"',
  '    exit_code: 0',
  '    duration_ms: 1234',
  '    output: "1 passing"',
  '    log_path: "logs/user-auth/FEAT-USER-AUTH-T001-1-tests.log"',
  'created_at: "2026-08-31T10:00:00Z"',
  'updated_at: "2026-08-31T10:05:00Z"',
  'locked_by: null',
  'locked_at: null',
  'pause_reason: null',
  'pause_detail: null',
  'resume_to: null',
  'reject_to: null',
  'paused_at: null',
  '---',
  '',
  'Body.',
  '',
].join('\n');

describe('FRONTMATTER_ORDER', () => {
  it('is the single source of key order and has no duplicates', () => {
    expect(new Set(FRONTMATTER_ORDER).size).toBe(FRONTMATTER_ORDER.length);
  });

  it('names every key a real feature note carries', () => {
    for (const key of Object.keys(makeFeature().frontmatter)) {
      expect(FRONTMATTER_ORDER, `feature key '${key}' is not ordered`).toContain(key);
    }
  });

  it('names every key a real ticket note carries', () => {
    for (const key of Object.keys(makeTicket().frontmatter)) {
      expect(FRONTMATTER_ORDER, `ticket key '${key}' is not ordered`).toContain(key);
    }
  });

  it('the compile-time coverage assertions hold', () => {
    expect(FRONTMATTER_ORDER_COVERS_DOMAIN).toBe(true);
    expect(FRONTMATTER_ORDER_HAS_NO_STRAYS).toBe(true);
  });
});

describe('round-trip fidelity across the adversarial corpus', () => {
  for (const [name, raw] of Object.entries(RAW_CORPUS)) {
    it(`parse(serialize(parse(x))) deep-equals parse(x) — ${name}`, () => {
      const once = parseNote<Record<string, unknown>>(raw, name);
      const twice = parseNote<Record<string, unknown>>(serializeNote(once), name);
      expect(twice.frontmatter).toEqual(once.frontmatter);
      expect(twice.body).toBe(once.body);
    });

    it(`serializing is idempotent from the second write on — ${name}`, () => {
      const first = serializeNote(parseNote<Record<string, unknown>>(raw, name));
      const second = serializeNote(parseNote<Record<string, unknown>>(first, name));
      expect(second).toBe(first);
    });
  }

  it('carries every hostile value through a full write/read cycle unchanged', () => {
    const note = { frontmatter: { ...HOSTILE_VALUES }, body: HOSTILE_BODY };
    const read = parseNote<Record<string, unknown>>(serializeNote(note), 'hostile.md');

    for (const [key, expected] of Object.entries(HOSTILE_VALUES)) {
      expect(read.frontmatter[key], `key '${key}' changed`).toEqual(expected);
    }
    expect(read.frontmatter).toEqual(HOSTILE_VALUES);
    expect(read.body).toBe(HOSTILE_BODY);
  });

  it('keeps hostile values identical over three consecutive writes', () => {
    const note = { frontmatter: { ...HOSTILE_VALUES }, body: HOSTILE_BODY };
    const first = serializeNote(note);
    const second = serializeNote(parseNote<Record<string, unknown>>(first, 'h.md'));
    const third = serializeNote(parseNote<Record<string, unknown>>(second, 'h.md'));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe('byte stability — a no-op read-then-write changes nothing', () => {
  it('a canonical feature note serializes back to identical bytes', () => {
    const note = parseNote<Record<string, unknown>>(CANONICAL_FEATURE, 'feature.md');
    expect(serializeNote(note)).toBe(CANONICAL_FEATURE);
  });

  it('a canonical ticket note serializes back to identical bytes', () => {
    const note = parseNote<Record<string, unknown>>(CANONICAL_TICKET, 'ticket.md');
    expect(serializeNote(note)).toBe(CANONICAL_TICKET);
  });

  it('the canonical form is what the serializer produces from a plain object', () => {
    // Guards the other direction: if the emitter's style drifts, the two
    // literals above would still pass by being re-derived from the drifted
    // output, but this comparison against a hand-written expectation will not.
    const feature = makeFeature(
      {
        id: 'FEAT-USER-AUTH',
        title: 'User authentication',
        status: 'refining',
        slug: 'user-auth',
        priority: 'high',
        created_at: '2026-08-31T10:00:00Z',
        updated_at: '2026-08-31T10:05:00Z',
      },
      [
        '',
        '## Raw Requirement',
        '',
        'Let people sign in.',
        '',
        '## History',
        '',
        '- 2026-08-31T10:05:00Z | intake → refining | orchestrator',
        '',
      ].join('\n'),
    );
    expect(serializeNote(feature)).toBe(CANONICAL_FEATURE);
  });

  it('changing only the status rewrites only the status and updated_at lines', () => {
    const before = CANONICAL_FEATURE;
    const note = parseNote<Record<string, unknown>>(before, 'feature.md');
    const after = serializeNote({
      frontmatter: { ...note.frontmatter, status: 'planning', updated_at: '2026-08-31T11:00:00Z' },
      body: note.body,
    });

    const changed = after
      .split('\n')
      .filter((line, index) => line !== before.split('\n')[index]);
    expect(changed).toEqual(['status: "planning"', 'updated_at: "2026-08-31T11:00:00Z"']);
  });
});

describe('type preservation', () => {
  it('an ISO timestamp survives as a quoted string, never a Date', () => {
    const raw = RAW_CORPUS['feature note, keys out of canonical order']!;
    const note = parseNote<Record<string, unknown>>(raw, 'f.md');

    expect(note.frontmatter['created_at']).toBe('2026-08-31T10:00:00Z');
    expect(note.frontmatter['created_at']).not.toBeInstanceOf(Date);
    expect(typeof note.frontmatter['created_at']).toBe('string');

    const out = serializeNote(note);
    expect(out).toContain('created_at: "2026-08-31T10:00:00Z"');
  });

  it('every timestamp field is emitted quoted', () => {
    const ticket = makeTicket({
      created_at: '2026-08-31T10:00:00Z',
      updated_at: '2026-08-31T10:00:01Z',
      locked_at: '2026-08-31T10:00:02Z',
      paused_at: '2026-08-31T10:00:03Z',
    });
    const out = serializeNote(ticket);
    for (const field of ['created_at', 'updated_at', 'locked_at', 'paused_at']) {
      expect(out).toMatch(new RegExp(`^${field}: "2026-08-31T10:00:0\\dZ"$`, 'm'));
    }
  });

  it('depends_on: [] stays an empty list and never becomes null', () => {
    const raw = RAW_CORPUS['ticket note with an empty dependency list']!;
    const note = parseNote<Record<string, unknown>>(raw, 't.md');
    expect(note.frontmatter['depends_on']).toEqual([]);

    const out = serializeNote(note);
    expect(out).toContain('depends_on: []');
    expect(out).not.toContain('depends_on: null');

    const again = parseNote<Record<string, unknown>>(out, 't.md');
    expect(again.frontmatter['depends_on']).toEqual([]);
  });

  it('null stays null and does not become the string "null"', () => {
    const note = parseNote<Record<string, unknown>>(
      RAW_CORPUS['ticket note with an empty dependency list']!,
      't.md',
    );
    expect(note.frontmatter['max_attempts']).toBeNull();
    expect(note.frontmatter['gate_results']).toBeNull();

    const again = parseNote<Record<string, unknown>>(serializeNote(note), 't.md');
    expect(again.frontmatter['max_attempts']).toBeNull();
    expect(again.frontmatter['gate_results']).toBeNull();
  });

  it('a bare `~` reads as null, and a quoted "~" stays the string', () => {
    const bare = parseNote<Record<string, unknown>>(
      RAW_CORPUS['feature note, keys out of canonical order']!,
      'f.md',
    );
    expect(bare.frontmatter['tag']).toBeNull();

    const quoted = parseNote<Record<string, unknown>>(
      RAW_CORPUS['note with hostile scalar shapes throughout']!,
      'h.md',
    );
    expect(quoted.frontmatter['tilde']).toBe('~');
  });

  it('YAML-truthy words stay strings, in and out', () => {
    const note = parseNote<Record<string, unknown>>(
      RAW_CORPUS['note with hostile scalar shapes throughout']!,
      'h.md',
    );
    expect(note.frontmatter['answer']).toBe('no');
    expect(note.frontmatter['switch']).toBe('on');
    expect(note.frontmatter['shorthand']).toBe('y');

    const out = serializeNote(note);
    expect(out).toContain('answer: "no"');
    expect(out).toContain('switch: "on"');
    expect(out).toContain('shorthand: "y"');
  });

  it('number-shaped strings stay strings', () => {
    const note = parseNote<Record<string, unknown>>(
      RAW_CORPUS['note with hostile scalar shapes throughout']!,
      'h.md',
    );
    expect(note.frontmatter['ticket_ref']).toBe('T001');
    expect(note.frontmatter['zeros']).toBe('012');
    expect(note.frontmatter['exponent']).toBe('1e3');

    const again = parseNote<Record<string, unknown>>(serializeNote(note), 'h.md');
    expect(again.frontmatter['zeros']).toBe('012');
    expect(typeof again.frontmatter['exponent']).toBe('string');
  });

  it('a very long single-line string is never wrapped', () => {
    const note = parseNote<Record<string, unknown>>(
      RAW_CORPUS['note with hostile scalar shapes throughout']!,
      'h.md',
    );
    const long = note.frontmatter['long'];
    expect(typeof long).toBe('string');
    expect((long as string).length).toBe(4997);

    const out = serializeNote(note);
    const longLine = out.split('\n').find((line) => line.startsWith('long: '));
    expect(longLine).toBeDefined();
    expect(longLine!.length).toBeGreaterThan(4990);
    expect(parseNote<Record<string, unknown>>(out, 'h.md').frontmatter['long']).toBe(long);
  });

  it('unicode is preserved literally, not escaped into \\u sequences', () => {
    const note = { frontmatter: { unicode: 'héllo — 日本語 🎉' }, body: '' };
    const out = serializeNote(note);
    expect(out).toContain('unicode: "héllo — 日本語 🎉"');
    expect(parseNote<Record<string, unknown>>(out, 'u.md').frontmatter['unicode']).toBe(
      'héllo — 日本語 🎉',
    );
  });

  it('numbers and booleans keep their JS types', () => {
    const note = {
      frontmatter: { attempts: 0, cost_usd: -1.5, big: 9007199254740991, flag: true },
      body: '',
    };
    const back = parseNote<Record<string, unknown>>(serializeNote(note), 'n.md');
    expect(back.frontmatter['attempts']).toBe(0);
    expect(back.frontmatter['cost_usd']).toBe(-1.5);
    expect(back.frontmatter['big']).toBe(9007199254740991);
    expect(back.frontmatter['flag']).toBe(true);
  });
});

describe('unknown keys', () => {
  it('a human-added unknown frontmatter key survives a write', () => {
    const raw = RAW_CORPUS['note with unknown human-added keys']!;
    const note = parseNote<Record<string, unknown>>(raw, 'unknown.md');
    expect(note.frontmatter['obsidian_tags']).toEqual(['factory', 'wip']);
    expect(note.frontmatter['cssclass']).toBe('factory-note');
    expect(note.frontmatter['reviewed_by_hand']).toBe('yes-please');

    const rewritten = parseNote<Record<string, unknown>>(serializeNote(note), 'unknown.md');
    expect(rewritten.frontmatter['obsidian_tags']).toEqual(['factory', 'wip']);
    expect(rewritten.frontmatter['cssclass']).toBe('factory-note');
    expect(rewritten.frontmatter['reviewed_by_hand']).toBe('yes-please');
  });

  it('survives a key the types have never heard of, with a hostile value', () => {
    const note = parseNote<Record<string, unknown>>(
      [
        '---',
        'type: "ticket"',
        'id: "FEAT-X-T001"',
        'status: "backlog"',
        'kanban_swimlane: "no"',
        'sprint: "012"',
        'due: "2026-09-30T00:00:00Z"',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
      'weird.md',
    );

    const out = serializeNote({
      frontmatter: { ...note.frontmatter, status: 'ready' },
      body: note.body,
    });
    const back = parseNote<Record<string, unknown>>(out, 'weird.md');

    expect(back.frontmatter['status']).toBe('ready');
    expect(back.frontmatter['kanban_swimlane']).toBe('no');
    expect(back.frontmatter['sprint']).toBe('012');
    expect(back.frontmatter['due']).toBe('2026-09-30T00:00:00Z');
  });

  it('emits unknown keys after every known key, in their original order', () => {
    const note = parseNote<Record<string, unknown>>(
      RAW_CORPUS['note with unknown human-added keys']!,
      'unknown.md',
    );
    const keys = frontmatterKeyOrder(serializeNote(note));
    const known = keys.filter((key) => (FRONTMATTER_ORDER as readonly string[]).includes(key));
    const unknown = keys.filter((key) => !(FRONTMATTER_ORDER as readonly string[]).includes(key));

    expect(unknown).toEqual(['obsidian_tags', 'cssclass', 'reviewed_by_hand']);
    expect(keys).toEqual([...known, ...unknown]);
  });
});

describe('key ordering', () => {
  it('frontmatter key order matches FRONTMATTER_ORDER regardless of input order', () => {
    const scrambled = RAW_CORPUS['feature note, keys out of canonical order']!;
    const emitted = frontmatterKeyOrder(
      serializeNote(parseNote<Record<string, unknown>>(scrambled, 'f.md')),
    );
    const expected = FRONTMATTER_ORDER.filter((key) => emitted.includes(key));
    expect(emitted).toEqual([...expected]);
  });

  it('a ticket and a feature both order their keys by the same tuple', () => {
    for (const note of [makeTicket(), makeFeature()]) {
      const emitted = frontmatterKeyOrder(
        serializeNote<TicketFrontmatter | FeatureFrontmatter>(note),
      );
      const expected = FRONTMATTER_ORDER.filter((key) => emitted.includes(key));
      expect(emitted).toEqual([...expected]);
    }
  });
});

describe('the fence split', () => {
  it('a body containing a literal --- line does not break the split', () => {
    const raw = RAW_CORPUS['note whose body contains a literal --- rule']!;
    const note = parseNote<Record<string, unknown>>(raw, 'rule.md');

    expect(note.frontmatter['id']).toBe('FEAT-RULE');
    expect(note.body).toContain('Before the rule.');
    expect(note.body).toContain('\n---\n');
    expect(note.body).toContain('After the rule.');
    expect(serializeNote(note)).toContain('After the rule.');
  });

  it('keeps a fenced code block containing --- inside the body', () => {
    const note = parseNote<Record<string, unknown>>(
      serializeNote({ frontmatter: { id: 'X' }, body: HOSTILE_BODY }),
      'code.md',
    );
    expect(note.body).toBe(HOSTILE_BODY);
    expect(note.frontmatter).toEqual({ id: 'X' });
  });

  it('an empty body round-trips as an empty body', () => {
    const raw = RAW_CORPUS['note with an empty body']!;
    const note = parseNote<Record<string, unknown>>(raw, 'empty.md');
    expect(note.body).toBe('');
    expect(serializeNote(note)).toBe(serializeNote({ ...note, body: '' }));
  });

  it('normalises CRLF input rather than corrupting the last value on each line', () => {
    const crlf = '---\r\ntype: "feature"\r\nid: "FEAT-CRLF"\r\n---\r\nBody\r\n';
    const note = parseNote<Record<string, unknown>>(crlf, 'crlf.md');
    expect(note.frontmatter['id']).toBe('FEAT-CRLF');
    expect(note.body).toBe('Body\n');
  });
});

describe('parse failures', () => {
  it('a note with no frontmatter throws NoteParseError naming the file', () => {
    expect(() => parseNote('Just a body, no fence.\n', 'work/features/x/feature.md')).toThrowError(
      NoteParseError,
    );
    try {
      parseNote('Just a body, no fence.\n', 'work/features/x/feature.md');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteParseError);
      expect((error as NoteParseError).source).toBe('work/features/x/feature.md');
      expect((error as Error).message).toContain('work/features/x/feature.md');
    }
  });

  it('a note with malformed YAML throws NoteParseError naming the file', () => {
    const raw = '---\nid: [1, 2\ntitle: broken\n---\nBody\n';
    try {
      parseNote(raw, 'work/features/x/tickets/T001.md');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteParseError);
      expect((error as NoteParseError).source).toBe('work/features/x/tickets/T001.md');
      expect((error as Error).message).toContain('work/features/x/tickets/T001.md');
    }
  });

  it('an unterminated frontmatter fence is a parse error, not a silent empty note', () => {
    expect(() => parseNote('---\nid: X\nno closing fence here\n', 'x.md')).toThrowError(
      NoteParseError,
    );
  });

  it('frontmatter that is a list rather than a mapping is a parse error', () => {
    expect(() => parseNote('---\n- a\n- b\n---\nBody\n', 'x.md')).toThrowError(NoteParseError);
  });

  it('serializing a note whose frontmatter is not an object is refused', () => {
    expect(() => serializeNote({ frontmatter: null, body: '' })).toThrowError(TypeError);
    expect(() => serializeNote({ frontmatter: [1, 2], body: '' })).toThrowError(TypeError);
  });

  it('a __proto__ key in frontmatter does not pollute the prototype', () => {
    const note = parseNote<Record<string, unknown>>(
      '---\nid: "X"\n__proto__:\n  polluted: true\n---\nBody\n',
      'proto.md',
    );
    expect(note.frontmatter['id']).toBe('X');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
