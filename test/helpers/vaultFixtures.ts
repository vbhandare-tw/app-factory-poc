/**
 * The adversarial frontmatter corpus.
 *
 * The round-trip guarantee in plan Phase 3 is only worth what the corpus is
 * worth. A corpus of tidy strings proves nothing, because the two failure modes
 * we actually fear — silent retyping and reformat churn — both pass a tidy
 * suite. Every entry below is here because a naive serializer gets it wrong:
 *
 *  - ISO timestamps          → a YAML 1.1 parser turns them into Date objects
 *  - `no` / `on` / `y` / `~` → YAML 1.1 turns them into booleans and null
 *  - `T001`, `012`, `1e3`    → an unquoted emit reparses as a number
 *  - `[]` / `{}`             → naive emitters write `null` instead
 *  - a literal `---` in body → breaks a greedy fence split
 *  - a 5000-char string      → a wrapping emitter folds it and changes the value
 *  - unknown keys            → destroyed by a serializer that only knows its own
 */

export interface HostileFrontmatter {
  [key: string]: unknown;
}

/**
 * Every shape that has ever silently changed type in a YAML round trip, as
 * plain JS values. Used both as a note's frontmatter and as the expectation.
 */
export const HOSTILE_VALUES: HostileFrontmatter = {
  // --- timestamps: the classic Date-object retype -------------------------
  iso_utc: '2026-08-31T10:00:00Z',
  iso_offset: '2026-08-31T10:00:00+05:30',
  iso_fractional: '2026-08-31T10:00:00.123456Z',
  date_only: '2026-08-31',
  time_only: '10:00:00',
  sexagesimal: '12:34:56',

  // --- YAML-truthy words that must stay strings ---------------------------
  word_no: 'no',
  word_yes: 'yes',
  word_on: 'on',
  word_off: 'off',
  word_y: 'y',
  word_n: 'n',
  word_true: 'true',
  word_True: 'True',
  word_null_lower: 'null',
  word_Null: 'Null',
  word_tilde: '~',

  // --- number-shaped strings ----------------------------------------------
  ticket_id: 'T001',
  leading_zeros: '012',
  exponent: '1e3',
  leading_dot: '.5',
  plain_int_string: '42',
  hex_ish: '0x1F',
  dash: '-',
  plus: '+',

  // --- real numbers and booleans, which must stay numbers and booleans -----
  real_zero: 0,
  real_negative: -1.5,
  real_big: 9007199254740991,
  real_true: true,
  real_false: false,

  // --- emptiness -----------------------------------------------------------
  empty_list: [],
  empty_map: {},
  empty_string: '',
  explicit_null: null,

  // --- strings that look like YAML structure -------------------------------
  looks_like_flow_seq: '[1, 2]',
  looks_like_flow_map: '{a: 1}',
  looks_like_comment: '# not a comment',
  looks_like_key: 'a: b',
  looks_like_anchor: '&anchor',
  looks_like_alias: '*alias',
  looks_like_tag: '!!str',
  looks_like_fence: '---',
  looks_like_bullet: '- item',
  padded: '  padded  ',
  trailing_newline: 'ends with newline\n',
  multiline: 'line one\nline two\n\nline four',

  // --- unicode and length ---------------------------------------------------
  unicode: 'héllo — 日本語 🎉 naïve Ω ß',
  rtl: 'שלום עולם',
  very_long: `${'x'.repeat(4993)}-END`,

  // --- nesting ---------------------------------------------------------------
  nested: {
    tests: { status: 'pass', exit_code: 0, output: 'ok\nsecond line' },
    list: ['a', 'no', '2026-08-31T10:00:00Z', 1, null],
  },

  // --- keys the type system has never heard of -------------------------------
  obsidian_tags: ['factory', 'wip'],
  cssclass: 'factory-note',
  'a human wrote this': 'and it must survive a write',
};

/** A body with every markdown shape that has broken a fence split before. */
export const HOSTILE_BODY = [
  '',
  '## Raw Requirement',
  '',
  'A body that starts after a blank line.',
  '',
  '---',
  '',
  'That was a literal horizontal rule, not a fence.',
  '',
  '```yaml',
  '---',
  'nested: fence',
  '---',
  '```',
  '',
  'Unicode: 日本語 — emoji 🎉 — RTL שלום.',
  '',
  '## History',
  '',
  '- 2026-08-31T10:00:00Z | intake → refining | orchestrator',
  '',
].join('\n');

/**
 * Hand-written raw notes. These are the *input* side of the round-trip test:
 * they are deliberately NOT in our canonical output form, so the test proves
 * that reading someone else's formatting still preserves every value.
 */
export const RAW_CORPUS: Readonly<Record<string, string>> = {
  'feature note, keys out of canonical order': [
    '---',
    'updated_at: 2026-08-31T10:05:00Z',
    'status: refining',
    'title: User authentication',
    'type: feature',
    'id: FEAT-USER-AUTH',
    'slug: user-auth',
    'priority: high',
    'attempts: 0',
    'cost_usd: 0',
    'feature_branch: null',
    'tag: ~',
    'created_at: 2026-08-31T10:00:00Z',
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
  ].join('\n'),

  'ticket note with an empty dependency list': [
    '---',
    'type: ticket',
    'id: FEAT-USER-AUTH-T001',
    'title: Add the login form',
    'status: backlog',
    'feature: user-auth',
    'ordinal: 1',
    'depends_on: []',
    'attempts: 0',
    'max_attempts: null',
    'cost_usd: 0',
    'branch: null',
    'worktree: null',
    'gate_results: null',
    'created_at: 2026-08-31T10:00:00Z',
    'updated_at: 2026-08-31T10:00:00Z',
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
  ].join('\n'),

  'note with unknown human-added keys': [
    '---',
    'type: feature',
    'id: FEAT-X',
    'title: X',
    'status: intake',
    'slug: x',
    'priority: low',
    'attempts: 0',
    'cost_usd: 0',
    'feature_branch: null',
    'tag: null',
    'created_at: 2026-08-31T10:00:00Z',
    'updated_at: 2026-08-31T10:00:00Z',
    'locked_by: null',
    'locked_at: null',
    'pause_reason: null',
    'pause_detail: null',
    'resume_to: null',
    'reject_to: null',
    'paused_at: null',
    'obsidian_tags: [factory, wip]',
    'cssclass: factory-note',
    'reviewed_by_hand: yes-please',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'),

  'note with an empty body': [
    '---',
    'type: feature',
    'id: FEAT-EMPTY',
    'title: Empty',
    'status: intake',
    'slug: empty',
    'priority: low',
    'attempts: 0',
    'cost_usd: 0',
    'feature_branch: null',
    'tag: null',
    'created_at: 2026-08-31T10:00:00Z',
    'updated_at: 2026-08-31T10:00:00Z',
    'locked_by: null',
    'locked_at: null',
    'pause_reason: null',
    'pause_detail: null',
    'resume_to: null',
    'reject_to: null',
    'paused_at: null',
    '---',
    '',
  ].join('\n'),

  'note whose body contains a literal --- rule': [
    '---',
    'type: feature',
    'id: FEAT-RULE',
    'title: Rule',
    'status: intake',
    'slug: rule',
    'priority: low',
    'attempts: 0',
    'cost_usd: 0',
    'feature_branch: null',
    'tag: null',
    'created_at: 2026-08-31T10:00:00Z',
    'updated_at: 2026-08-31T10:00:00Z',
    'locked_by: null',
    'locked_at: null',
    'pause_reason: null',
    'pause_detail: null',
    'resume_to: null',
    'reject_to: null',
    'paused_at: null',
    '---',
    '',
    'Before the rule.',
    '',
    '---',
    '',
    'After the rule.',
    '',
  ].join('\n'),

  'note with hostile scalar shapes throughout': [
    '---',
    'type: feature',
    'id: FEAT-HOSTILE',
    'title: Hostile',
    'status: intake',
    'slug: hostile',
    'priority: low',
    'attempts: 0',
    'cost_usd: 0',
    'feature_branch: null',
    'tag: null',
    'created_at: "2026-08-31T10:00:00Z"',
    'updated_at: "2026-08-31T10:00:00Z"',
    'locked_by: null',
    'locked_at: null',
    'pause_reason: null',
    'pause_detail: null',
    'resume_to: null',
    'reject_to: null',
    'paused_at: null',
    'ticket_ref: "T001"',
    'answer: "no"',
    'switch: "on"',
    'shorthand: "y"',
    'tilde: "~"',
    'zeros: "012"',
    'exponent: "1e3"',
    'blank: ""',
    'empty_list: []',
    'empty_map: {}',
    `long: "${'x'.repeat(4993)}-END"`,
    'unicode: "héllo — 日本語 🎉"',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'),
};
