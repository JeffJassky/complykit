import { describe, it, expect } from 'vitest';
import { filterFindings, partialStamp, splitList } from '../src/cli/targeting.js';
import { asRunId, asRuleId, asRequirementId, fingerprint, type Finding } from '../src/index.js';

function mk(rule: string, req: string): Finding {
  const sub = { property: 'shop', routePattern: '/', locator: { role: 'text', ordinal: 0 } };
  return {
    schemaVersion: 1,
    ruleId: asRuleId(rule),
    requirementId: asRequirementId(req),
    subject: sub,
    confidence: 'violation',
    severity: 'serious',
    message: 'm',
    evidence: [],
    fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId(rule), subject: sub }),
    producer: { type: 'engine', name: 'axe-core', version: '1' },
    runId: asRunId('2026-08-21T10-00-00.000Z'),
  };
}

const set = [
  mk('axe-core:color-contrast', 'wcag22.1.4.3'),
  mk('contrast.text', 'wcag22.1.4.3'),
  mk('keyboard.focus-visible', 'wcag22.2.4.7'),
  mk('consent.click-asymmetry', 'gdpr.art7.3'),
];

describe('scan targeting', () => {
  it('rules match as case-insensitive ruleId substrings', () => {
    const out = filterFindings(set, { rules: 'Color-Contrast,contrast.text' });
    expect(out.map((f) => String(f.ruleId))).toEqual(['axe-core:color-contrast', 'contrast.text']);
  });

  it('requirements and law match as prefixes', () => {
    expect(filterFindings(set, { requirements: 'wcag22.1.4' })).toHaveLength(2);
    expect(filterFindings(set, { law: 'gdpr' }).map((f) => String(f.ruleId))).toEqual(['consent.click-asymmetry']);
  });

  it('rule and requirement filters intersect; no filters = passthrough', () => {
    expect(filterFindings(set, { rules: 'contrast', law: 'gdpr' })).toHaveLength(0);
    expect(filterFindings(set, {})).toHaveLength(4);
  });

  it('partialStamp records exactly the flags passed', () => {
    expect(partialStamp({})).toBeUndefined();
    expect(partialStamp({ routes: '/app/aeo', schemes: 'dark' })).toEqual({ routes: '/app/aeo', schemes: 'dark' });
  });

  it('splitList trims and drops empties', () => {
    expect(splitList(' a, ,b ,')).toEqual(['a', 'b']);
    expect(splitList(undefined)).toEqual([]);
  });
});
