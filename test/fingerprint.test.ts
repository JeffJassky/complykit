import { describe, it, expect } from 'vitest';
import { fingerprint, asRuleId, asRequirementId, type Subject } from '../src/index.js';

// The fingerprint is v1-FROZEN (build-plan §7). These tests lock the algorithm:
// a change to the canonical tuple changes these hashes and fails here, forcing a
// deliberate v2 + a dispositions migration rather than a silent re-key.

const baseSubject: Subject = {
  property: 'shop',
  routePattern: '/product/:id',
  locator: { role: 'button', name: 'Buy', landmark: 'main', ordinal: 0, cssPath: '.x>.y' },
  instanceUrl: 'https://shop/product/42',
  viewport: 'mobile',
  colorScheme: 'dark',
};

describe('fingerprint v1 (frozen)', () => {
  it('produces the frozen hash for a known presence subject', () => {
    const fp = fingerprint({ detects: 'presence', ruleId: asRuleId('contrast.text'), subject: baseSubject });
    expect(fp).toBe('4c28f5fb20da18e0f5d98b4df1673e40cc3d0072bbd156e2a34b7b5f9e453c8f');
  });

  it('produces the frozen hash for a known absence subject', () => {
    const fp = fingerprint({
      detects: 'absence',
      requirementId: asRequirementId('gdpr.art13'),
      subject: { property: 'shop', routePattern: '/checkout' },
    });
    expect(fp).toBe('c708dcbe739e952471180bed3e3f49dddcfcf20edcae3b1cf27b6143867239cc');
  });

  it('ignores instanceUrl, viewport, scheme, cssPath — variants of one defect converge', () => {
    const a = fingerprint({ detects: 'presence', ruleId: asRuleId('contrast.text'), subject: baseSubject });
    const b = fingerprint({
      detects: 'presence',
      ruleId: asRuleId('contrast.text'),
      subject: {
        ...baseSubject,
        instanceUrl: 'https://shop/product/999',
        viewport: 'desktop',
        colorScheme: 'light',
        locator: { ...baseSubject.locator!, cssPath: 'totally.different' },
      },
    });
    expect(b).toBe(a);
  });

  it('does not collide a presence finding with an absence finding on the same subject', () => {
    const p = fingerprint({ detects: 'presence', ruleId: asRuleId('x'), subject: { property: 'p', routePattern: '/r' } });
    const a = fingerprint({ detects: 'absence', requirementId: asRequirementId('x'), subject: { property: 'p', routePattern: '/r' } });
    expect(p).not.toBe(a);
  });

  it('distinguishes a different route pattern', () => {
    const a = fingerprint({ detects: 'absence', requirementId: asRequirementId('r'), subject: { property: 'p', routePattern: '/a' } });
    const b = fingerprint({ detects: 'absence', requirementId: asRequirementId('r'), subject: { property: 'p', routePattern: '/b' } });
    expect(a).not.toBe(b);
  });
});
