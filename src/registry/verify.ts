import { Requirement, Instrument, EngineRuleMapping } from './schema.js';
import { INSTRUMENTS } from './instruments.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';
import { AXE_MAPPINGS, AXE_PINNED_RULES, AXE_VERSION } from './mappings/axe.js';

// `complykit registry verify` runs this. It is also a CI gate: an axe upgrade
// that adds an unmapped rule fails HERE (registry-design.md — engine drift as a
// reviewable diff, never a silent coverage change).

export interface VerifyReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { requirements: number; instruments: number; mappings: number };
  /** verified-date staleness / bot-blocked / volatile items — the release checklist. */
  needsHumanCheck: Array<{ id: string; reason: string }>;
}

export function verifyRegistry(sinceLastRelease?: string): VerifyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const needsHumanCheck: VerifyReport['needsHumanCheck'] = [];

  // 1. Every instrument validates; ids unique.
  const instrumentIds = new Set<string>();
  for (const inst of INSTRUMENTS) {
    const parsed = Instrument.safeParse(inst);
    if (!parsed.success) {
      errors.push(`instrument ${String(inst.id)}: ${parsed.error.message}`);
      continue;
    }
    if (instrumentIds.has(String(inst.id))) errors.push(`duplicate instrument id: ${String(inst.id)}`);
    instrumentIds.add(String(inst.id));
  }

  // 2. Every requirement validates; ids unique; instrument + supersedes resolve.
  const reqIds = new Set<string>();
  for (const req of ALL_REQUIREMENTS) {
    const parsed = Requirement.safeParse(req);
    if (!parsed.success) {
      errors.push(`requirement ${String(req.id)}: ${parsed.error.message}`);
      continue;
    }
    if (reqIds.has(String(req.id))) errors.push(`duplicate requirement id: ${String(req.id)}`);
    reqIds.add(String(req.id));
    if (!instrumentIds.has(String(req.instrument))) {
      errors.push(`requirement ${String(req.id)} references unknown instrument ${String(req.instrument)}`);
    }
  }
  // supersedes must resolve (second pass — all ids known now).
  for (const req of ALL_REQUIREMENTS) {
    if (req.supersedes && !reqIds.has(String(req.supersedes))) {
      errors.push(`requirement ${String(req.id)} supersedes unknown ${String(req.supersedes)}`);
    }
  }

  // 3. Engine mappings validate; requirements resolve; exhaustive vs pinned rules.
  const mappedAxeRules = new Set<string>();
  for (const m of AXE_MAPPINGS) {
    const parsed = EngineRuleMapping.safeParse(m);
    if (!parsed.success) {
      errors.push(`axe mapping ${m.engineRule}: ${parsed.error.message}`);
      continue;
    }
    if (m.engineVersion !== AXE_VERSION) {
      errors.push(`axe mapping ${m.engineRule} pinned to ${m.engineVersion}, expected ${AXE_VERSION}`);
    }
    for (const r of m.requirements) {
      if (!reqIds.has(String(r))) {
        errors.push(`axe mapping ${m.engineRule} references unknown requirement ${String(r)}`);
      }
    }
    if (!AXE_PINNED_RULES.includes(m.engineRule)) {
      errors.push(`axe mapping ${m.engineRule} is not in the pinned rule set (stale mapping or typo)`);
    }
    mappedAxeRules.add(m.engineRule);
  }
  // Exhaustiveness: every pinned rule must be mapped. This is the upgrade gate.
  for (const rule of AXE_PINNED_RULES) {
    if (!mappedAxeRules.has(rule)) {
      errors.push(`axe rule "${rule}" (v${AXE_VERSION}) is unmapped — map it to a requirement or CI stays red`);
    }
  }

  // 4. Release checklist: staleness + bot-blocked + volatile.
  for (const req of ALL_REQUIREMENTS) {
    if (req.volatile) needsHumanCheck.push({ id: String(req.id), reason: 'volatile: recheck each release' });
    for (const url of req.urls) {
      if (url.botBlocked) {
        needsHumanCheck.push({ id: String(req.id), reason: `bot-blocked source needs one human click: ${url.href}` });
      }
      if (sinceLastRelease && url.verified && url.verified < sinceLastRelease) {
        needsHumanCheck.push({ id: String(req.id), reason: `source last verified ${url.verified}, before ${sinceLastRelease}` });
      }
      if (sinceLastRelease && !url.verified) {
        warnings.push(`requirement ${String(req.id)} has an unverified source URL: ${url.href}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      requirements: ALL_REQUIREMENTS.length,
      instruments: INSTRUMENTS.length,
      mappings: AXE_MAPPINGS.length,
    },
    needsHumanCheck,
  };
}

/**
 * Runtime engine-drift check (M2): given the rules an engine actually reported,
 * fail on any not present in the mapping table. Same law, checked against live
 * output instead of the pinned constant.
 */
export function unmappedEngineRules(engine: string, observedRules: string[]): string[] {
  if (engine !== 'axe-core') return [];
  const mapped = new Set(AXE_MAPPINGS.map((m) => m.engineRule));
  return observedRules.filter((r) => !mapped.has(r));
}
