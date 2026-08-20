import { describe, it, expect } from 'vitest';
import { classifyCookie, requiresConsent } from '../src/index.js';

describe('cookie classification', () => {
  it('classifies known analytics and advertising cookies with a vendor', () => {
    expect(classifyCookie('_ga')).toEqual({ category: 'analytics', vendor: 'Google Analytics' });
    expect(classifyCookie('_ga_ABC123')).toEqual({ category: 'analytics', vendor: 'Google Analytics' });
    expect(classifyCookie('_fbp')).toMatchObject({ category: 'advertising', vendor: 'Meta Pixel' });
    expect(classifyCookie('_gcl_au')).toMatchObject({ category: 'advertising' });
  });

  it('treats session, CSRF, and consent cookies as necessary', () => {
    expect(classifyCookie('session_id').category).toBe('necessary');
    expect(classifyCookie('csrf_token').category).toBe('necessary');
    expect(classifyCookie('OptanonConsent').category).toBe('necessary');
  });

  it('returns unknown for an unrecognised name', () => {
    expect(classifyCookie('some_random_cookie')).toEqual({ category: 'unknown' });
  });

  it('requiresConsent is true only for analytics and advertising', () => {
    expect(requiresConsent('analytics')).toBe(true);
    expect(requiresConsent('advertising')).toBe(true);
    expect(requiresConsent('necessary')).toBe(false);
    expect(requiresConsent('functional')).toBe(false);
    expect(requiresConsent('unknown')).toBe(false);
  });
});
