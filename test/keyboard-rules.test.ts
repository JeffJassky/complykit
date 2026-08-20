import { describe, it, expect } from 'vitest';
import { getRule } from '../src/index.js';
import type { Artifact, RawFinding } from '../src/index.js';

function run(ruleId: string, artifacts: Artifact[]): RawFinding[] {
  const rule = getRule(ruleId);
  if (!rule || rule.layer === 'llm' || !('evaluate' in rule)) throw new Error('not a deterministic rule');
  return rule.evaluate({ 'focus-walk': artifacts } as never, { property: 'shop' });
}

const focusWalk = (stops: unknown[], traps: unknown[]): Artifact => ({
  kind: 'focus-walk',
  subject: { property: 'shop', routePattern: '/' },
  capturedAt: '2026-08-19T00:00:00.000Z',
  stops: stops as Record<string, unknown>[],
  traps: traps as Record<string, unknown>[],
});

describe('keyboard rules', () => {
  it('reports a keyboard trap as a violation of 2.1.2', () => {
    const findings = run('keyboard.trap', [focusWalk([], [{ atIndex: 5, reason: 'no-advance' }])]);
    expect(findings).toHaveLength(1);
    expect(String(findings[0].requirementId)).toBe('wcag22.2.1.2');
    expect(findings[0].confidence).toBe('violation');
  });

  it('flags focus stops with no visible indicator as needs-review (2.4.7)', () => {
    const findings = run('keyboard.focus-visible', [
      focusWalk(
        [
          { index: 0, tag: 'button', name: 'Buy', hasVisibleFocus: false, lostToBody: false },
          { index: 1, tag: 'a', name: 'Home', hasVisibleFocus: true, lostToBody: false },
          { index: 2, tag: 'body', name: '', hasVisibleFocus: false, lostToBody: true },
        ],
        [],
      ),
    ]);
    // Only the first stop (no visible focus, not body) is flagged.
    expect(findings).toHaveLength(1);
    expect(String(findings[0].requirementId)).toBe('wcag22.2.4.7');
    expect(findings[0].confidence).toBe('needs-review');
  });
});
