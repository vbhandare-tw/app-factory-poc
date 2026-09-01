/**
 * Per-role model resolution (plan resolution A7).
 *
 * The consequence of getting this wrong is a bill, not a crash: a role silently
 * promoted to Opus across 12+ runs per feature costs real money and nothing
 * goes red.
 */
import { describe, expect, it } from 'vitest';

import { ConfigSchema } from '../../../src/config/schema.js';
import { ROLES } from '../../../src/domain/roles.js';
import { DEFAULT_MODEL, resolveModel } from '../../../src/runner/models.js';

describe('resolveModel', () => {
  it('falls back to models.default when the role has no entry', () => {
    expect(resolveModel('developer', { models: { default: 'haiku' } })).toBe('haiku');
  });

  it('prefers a per-role override over the default', () => {
    expect(resolveModel('tl_plan', { models: { default: 'sonnet', tl_plan: 'opus' } })).toBe('opus');
    // ...and the override must not leak to any other role.
    expect(resolveModel('developer', { models: { default: 'sonnet', tl_plan: 'opus' } })).toBe(
      'sonnet',
    );
  });

  it('resolves every role to sonnet under the shipped config defaults', () => {
    const config = ConfigSchema.parse({ target_repo: '/tmp/x' });
    for (const role of ROLES) {
      expect(resolveModel(role, config), `role ${role}`).toBe('sonnet');
    }
    expect(DEFAULT_MODEL).toBe('sonnet');
  });

  it('falls back to sonnet for a hand-built config with no models at all', () => {
    expect(resolveModel('qa', { models: {} })).toBe(DEFAULT_MODEL);
  });
});
