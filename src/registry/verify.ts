import { Requirement, Instrument, EngineRuleMapping } from './schema.js';
import { INSTRUMENTS } from './instruments.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';
import { ENGINE_TABLES, ALL_ENGINE_MAPPINGS } from './mappings/index.js';

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

  // 3. Every engine table: mappings validate, requirements resolve, versions
  //    match, and the table is EXHAUSTIVE against the pinned rule set. An engine
  //    upgrade that adds a rule breaks CI here until it is mapped.
  for (const table of ENGINE_TABLES) {
    const mapped = new Set<string>();
    for (const m of table.mappings) {
      const parsed = EngineRuleMapping.safeParse(m);
      if (!parsed.success) {
        errors.push(`${table.engine} mapping ${m.engineRule}: ${parsed.error.message}`);
        continue;
      }
      if (m.engineVersion !== table.version) {
        errors.push(`${table.engine} mapping ${m.engineRule} pinned to ${m.engineVersion}, expected ${table.version}`);
      }
      for (const r of m.requirements) {
        if (!reqIds.has(String(r))) {
          errors.push(`${table.engine} mapping ${m.engineRule} references unknown requirement ${String(r)}`);
        }
      }
      if (!table.pinnedRules.includes(m.engineRule)) {
        errors.push(`${table.engine} mapping ${m.engineRule} is not in the pinned rule set (stale mapping or typo)`);
      }
      mapped.add(m.engineRule);
    }
    for (const rule of table.pinnedRules) {
      if (!mapped.has(rule)) {
        errors.push(`${table.engine} rule "${rule}" (v${table.version}) is unmapped — map it to a requirement or CI stays red`);
      }
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
      mappings: ALL_ENGINE_MAPPINGS.length,
    },
    needsHumanCheck,
  };
}

/**
 * Runtime engine-drift check: given the rules an engine actually reported, fail
 * on any not present in the mapping table. Same law, checked against live output
 * instead of the pinned constant.
 */
export function unmappedEngineRules(engine: string, observedRules: string[]): string[] {
  const table = ENGINE_TABLES.find((t) => t.engine === engine);
  if (!table) return [];
  const mapped = new Set(table.mappings.map((m) => m.engineRule));
  return observedRules.filter((r) => !mapped.has(r));
}
