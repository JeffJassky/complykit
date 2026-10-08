import { describe, expect, it } from 'vitest';
import { describeLocationRules } from '../src/registry/index.js';
import { LAWS } from '../service/src/shared/laws.js';

// The service hard-codes each law's model line. If a label changes in the
// registry, this fails and the form copy is updated with it.

const TODAY = new Date().toISOString().slice(0, 10);

function jurisdictions(locationId: string): string[] {
  if (locationId === 'de') return ['eu', 'eu-de'];
  if (locationId === 'uk') return ['uk'];
  if (locationId.startsWith('us-')) return ['us', locationId];
  throw new Error(`unmapped location id ${locationId}`);
}

describe('service law catalog matches the registry', () => {
  for (const law of LAWS) {
    it(`${law.id} (${law.locationId}) model equals the registry label`, () => {
      expect(law.model).toBe(describeLocationRules(jurisdictions(law.locationId), TODAY).label);
    });
  }
});
