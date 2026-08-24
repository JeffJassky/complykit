import { describe, it, expect } from 'vitest';
import { axeContrastTargets } from '../src/collect/browser/axe-contrast-measure.js';

describe('axe contrast target extraction', () => {
  const results = {
    violations: [
      { id: 'color-contrast', nodes: [{ target: ['.a'] }] },
      { id: 'link-name', nodes: [{ target: ['.ignored'] }] },
    ],
    incomplete: [
      { id: 'color-contrast', nodes: [{ target: ['div[aria-label="Visibility: 94%"]', '.tabular-nums'] }, { target: ['.a'] }] },
    ],
  };

  it('takes color-contrast targets from both violations and incomplete', () => {
    expect(axeContrastTargets(results)).toEqual(['.a', 'div[aria-label="Visibility: 94%"] .tabular-nums']);
  });

  it('ignores other rules and malformed payloads', () => {
    expect(axeContrastTargets({ violations: [{ id: 'region', nodes: [{ target: ['.x'] }] }] })).toEqual([]);
    expect(axeContrastTargets(undefined)).toEqual([]);
    expect(axeContrastTargets({ violations: 'nope' })).toEqual([]);
  });
});
