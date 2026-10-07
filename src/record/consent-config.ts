import { z } from 'zod/v4';
import { createHash } from 'node:crypto';
import {
  CONSENT_ADAPTER_IDS,
  CONSENT_CONFIG_VERSION,
  NECESSARY_CATEGORY,
  REGIMES,
  CONSENT_STRING_KEYS,
  consentConfigVersionStatus,
  type ConsentStringKey,
  type ConsentToolConfig,
  type ConsentConfigVersionStatus,
} from './consent-config-guard.js';
import { validateConsentStrings } from './consent-strings-guard.js';

// The consent tool's config schema (client-consent epic, ticket D2): what the
// generator writes into the snippet, what the tool reads, what the rescan reads
// back and compares with the workspace (plans/client-consent-design.md §10).
//
// zod v4 (the `zod/v4` subpath of the zod 3.25 line) because it emits JSON
// Schema natively — the editor schema in schema/consent-tool-config.schema.json
// is generated from this file, never hand-maintained. Everything else in
// record/ is on the v3 API; the two do not mix inside one schema, which is why
// this file redefines IsoDate instead of importing ids.ts.
//
// Fail-closed rules enforced here, not left to the reader:
//   - `necessary` is the only always-granted category and must be present.
//   - no other category defaults to granted under `opt-in`.
//   - every vendor, gate rule and GTM mapping names a category the config lists;
//     a category nobody listed is denied (consent-config-guard.ts).
//   - control 'api' needs an adapter; control 'platform' needs a platform.

const IsoDate = z.string().min(1);
const CategoryId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'lower-case id: letters, digits, hyphens')
  .describe('Category id, as used in data-category and the consent record.');
const compiles = (src: string): boolean => {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
};
const RegexSource = z
  .string()
  .min(1)
  .refine(compiles, 'not a valid regular expression')
  .describe('A JavaScript regular-expression source (no slashes, no flags).');

/** Consent Mode signals that are tracking by definition: never granted through `necessary`. */
const TRACKING_SIGNALS = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'] as const;

// Literal lists repeat the guard's `REGIMES` / `CONSENT_MODE_SIGNALS` on purpose: zod
// wants tuples, and src/contract.ts keeps the inferred types equal to the guard's.
export const RegimeSchema = z.enum(['opt-in', 'opt-out-signal', 'opt-out']);

export const RegimeSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('header'),
      header: z.string().min(1).describe('The request header the endpoint echoes, e.g. cf-ipcountry.'),
      endpoint: z.string().regex(/^\//, 'same-origin path').describe('Same-origin path whose body is "CC" or "CC-RR".'),
    }),
    z.object({
      kind: z.literal('meta'),
      name: z.string().min(1).default('complykit-region').describe('<meta name> whose content is "CC" or "CC-RR".'),
    }),
    z.object({ kind: z.literal('platform') }),
    z.object({ kind: z.literal('fixed'), regime: RegimeSchema }),
  ])
  .describe('Where the tool learns the visitor location. Never a third-party geo call; unknown ⇒ opt-in.');

export const ConsentCategorySchema = z.object({
  id: CategoryId,
  label: z.string().min(1),
  description: z.string(),
  defaultByRegime: z
    .object({ 'opt-in': z.boolean(), 'opt-out-signal': z.boolean(), 'opt-out': z.boolean() })
    .describe('Granted before the visitor chooses, per regime.'),
});

export const VendorControlSchema = z.enum(['gate', 'api', 'platform', 'none']);

export const ConsentVendorSchema = z.object({
  id: z.string().min(1).describe('Knowledge-base entry id, e.g. meta.pixel.'),
  label: z.string().min(1),
  category: CategoryId,
  control: VendorControlSchema,
  adapter: z.string().min(1).optional().describe("Adapter id; required when control is 'api'."),
  stores: z
    .array(z.object({ name: RegexSource, kind: z.enum(['cookie', 'local', 'session']).default('cookie') }))
    .default([])
    .describe('Keys this vendor sets, for withdrawal cleanup.'),
  note: z.string().optional(),
});

export const GateRuleSchema = z.object({
  category: CategoryId,
  src: RegexSource.optional(),
  selector: z.string().min(1).optional(),
  vendor: z.string().min(1).optional(),
});

export const ConsentModeSignalSchema = z.enum([
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
]);

export const GtmConfigSchema = z.object({
  containers: z.array(z.string().regex(/^GTM-[A-Z0-9]+$/)).min(1),
  dataLayer: z.string().min(1).default('dataLayer'),
  consentMode: z
    .object({
      ad_storage: CategoryId.optional(),
      ad_user_data: CategoryId.optional(),
      ad_personalization: CategoryId.optional(),
      analytics_storage: CategoryId.optional(),
      functionality_storage: CategoryId.optional(),
      personalization_storage: CategoryId.optional(),
      security_storage: CategoryId.optional(),
    })
    .default({})
    .describe('Consent Mode signal → category that grants it. Unmapped signals stay denied.'),
  tags: z.array(z.object({ name: z.string().min(1), category: CategoryId, vendor: z.string().min(1).optional() })).default([]),
});

export const ConsentPlatformSchema = z.enum(['none', 'shopify', 'wix', 'squarespace', 'wordpress']);

export const ConsentThemeSchema = z
  .object({
    bg: z.string().optional(),
    fg: z.string().optional(),
    accent: z.string().optional(),
    border: z.string().optional(),
    radius: z.string().optional(),
  })
  .describe('CSS values for --ck-bg, --ck-fg, --ck-accent, --ck-border, --ck-radius. Font is always inherit.');

export const ConsentLayoutSchema = z.enum(['bar', 'box', 'modal']);

const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 language tag');

// String tables are STRICT: an unknown key is a typo the visitor would never see
// (the tool falls back to its default silently), and an empty string would blank
// a required control. Both are refused at generation time instead.
const NonEmpty = z.string().min(1);
const stringKeyShape = Object.fromEntries(CONSENT_STRING_KEYS.map((k) => [k, NonEmpty.optional()])) as Record<
  ConsentStringKey,
  z.ZodOptional<z.ZodString>
>;
const StringKeyTable = z.strictObject(stringKeyShape);
export const ConsentStringTableSchema = z
  .strictObject({
    ...stringKeyShape,
    byRegime: z
      .strictObject({ 'opt-in': StringKeyTable.optional(), 'opt-out-signal': StringKeyTable.optional(), 'opt-out': StringKeyTable.optional() })
      .optional()
      .describe('Per-regime overrides of the same keys.'),
  })
  .describe('Overrides by string key; unknown keys and empty strings are refused.');

export const ConsentStateConfigSchema = z.object({
  lifetimeDays: z.number().int().min(1).max(395).default(365).describe('Days a choice is remembered. At most 395 (13 months).'),
  cookieDomain: z.string().min(1).optional().describe('Cookie domain, e.g. ".example.test"; default: the current host.'),
});

export const ConsentToolConfigSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+$/).describe('Config schema version "<major>.<minor>".'),
    generatedFrom: z.object({
      runId: z.string().min(1),
      at: IsoDate,
      site: z
        .string()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'registrable domain, lower-case')
        .describe('Registrable domain the scan ran against, e.g. example-shop.test.'),
      complykit: z.string().min(1).describe('complykit package version that generated this.'),
      kb: z.string().min(1).optional().describe('Knowledge-base version.'),
    }),
    hash: z.string().regex(/^[0-9a-f]{64}$/).describe('sha-256 of the canonical JSON of every other field.'),
    regimeSource: RegimeSourceSchema,
    categories: z.array(ConsentCategorySchema).min(1),
    vendors: z.array(ConsentVendorSchema).default([]),
    gate: z.array(GateRuleSchema).default([]),
    gtm: GtmConfigSchema.optional(),
    platform: ConsentPlatformSchema.default('none'),
    theme: ConsentThemeSchema.default({}),
    strings: z.record(LanguageTag, ConsentStringTableSchema).default({}).describe('language tag → string table (overrides only).'),
    consent: ConsentStateConfigSchema.default({ lifetimeDays: 365 }),
    privacyPolicyUrl: z.string().regex(/^https:\/\/[^\s]+$/, 'https URL').optional().describe('Linked from the banner.'),
    record: z.object({ endpoint: z.string().min(1) }).optional(),
    layout: ConsentLayoutSchema.default('bar'),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const ids = new Set<string>();
    cfg.categories.forEach((c, i) => {
      if (ids.has(c.id)) issue(['categories', i, 'id'], `duplicate category "${c.id}"`);
      ids.add(c.id);
      const nec = c.id === NECESSARY_CATEGORY;
      for (const r of REGIMES) {
        if (nec && !c.defaultByRegime[r]) issue(['categories', i, 'defaultByRegime', r], `"${NECESSARY_CATEGORY}" is always granted`);
      }
      if (!nec && c.defaultByRegime['opt-in']) issue(['categories', i, 'defaultByRegime', 'opt-in'], 'nothing but "necessary" is granted by default under opt-in');
    });
    if (!ids.has(NECESSARY_CATEGORY)) issue(['categories'], `the "${NECESSARY_CATEGORY}" category must be present`);
    const vendorIds = new Set<string>();
    cfg.vendors.forEach((v, i) => {
      if (vendorIds.has(v.id)) issue(['vendors', i, 'id'], `duplicate vendor "${v.id}"`);
      vendorIds.add(v.id);
      if (!ids.has(v.category)) issue(['vendors', i, 'category'], `unknown category "${v.category}"`);
      if (v.control === 'api' && !v.adapter) issue(['vendors', i, 'adapter'], "control 'api' needs an adapter");
      if (v.adapter && !(CONSENT_ADAPTER_IDS as readonly string[]).includes(v.adapter)) issue(['vendors', i, 'adapter'], `unknown adapter "${v.adapter}" (one of ${CONSENT_ADAPTER_IDS.join(', ')})`);
      if (v.control === 'platform' && cfg.platform === 'none') issue(['vendors', i, 'control'], "control 'platform' needs a platform");
    });
    cfg.gate.forEach((g, i) => {
      if (!g.src && !g.selector) issue(['gate', i], 'a gate rule needs src or selector');
      if (!ids.has(g.category)) issue(['gate', i, 'category'], `unknown category "${g.category}"`);
      if (g.vendor && !vendorIds.has(g.vendor)) issue(['gate', i, 'vendor'], `unknown vendor "${g.vendor}"`);
    });
    if (cfg.gtm) {
      for (const [signal, cat] of Object.entries(cfg.gtm.consentMode)) {
        if (cat && !ids.has(cat)) issue(['gtm', 'consentMode', signal], `unknown category "${cat}"`);
        if (cat === NECESSARY_CATEGORY && (TRACKING_SIGNALS as readonly string[]).includes(signal)) {
          issue(['gtm', 'consentMode', signal], `${signal} cannot be granted by "${NECESSARY_CATEGORY}" (it would be granted before any choice)`);
        }
      }
      cfg.gtm.tags.forEach((t, i) => {
        if (!ids.has(t.category)) issue(['gtm', 'tags', i, 'category'], `unknown category "${t.category}"`);
        if (t.vendor && !vendorIds.has(t.vendor)) issue(['gtm', 'tags', i, 'vendor'], `unknown vendor "${t.vendor}"`);
      });
    }
    if (cfg.regimeSource.kind === 'platform' && cfg.platform === 'none') issue(['regimeSource'], "regimeSource 'platform' needs a platform");
    // Required strings and misleading copy (F2): errors refuse the config; warnings
    // are left to validateConsentStrings' other callers (report, owner review).
    for (const s of validateConsentStrings(cfg.strings)) {
      if (s.severity === 'error') issue(s.path, `${s.message} [${s.rule}; ${s.regimes.join(', ')}]`);
    }
  });

/** The shape as written by hand (defaults optional); `ConsentToolConfig` is the parsed shape. */
export type ConsentToolConfigInput = z.input<typeof ConsentToolConfigSchema>;

// --- canonical form and hash --------------------------------------------------------

/**
 * Canonical JSON: object keys sorted (recursively), arrays in order, `undefined`
 * members omitted, no whitespace. The same config serialized by any writer
 * hashes the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha-256 (hex) over the canonical JSON of the config with `hash` removed. Computed on the PARSED form. */
export function hashConsentToolConfig(config: Omit<ConsentToolConfig, 'hash'> & { hash?: string }): string {
  const { hash: _omit, ...rest } = config;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** Parse (defaults filled, invariants checked) and stamp the hash. The generator's last step. */
export function withConsentConfigHash(input: Omit<ConsentToolConfigInput, 'hash'> & { hash?: string }): ConsentToolConfig {
  const placeholder = '0'.repeat(64);
  const parsed = ConsentToolConfigSchema.parse({ ...input, hash: placeholder });
  return { ...parsed, hash: hashConsentToolConfig(parsed) };
}

// --- parsing with the migration policy ---------------------------------------------

export interface ConsentConfigIssue {
  path: string;
  message: string;
}

export type ParseConsentToolConfigResult =
  | {
      ok: true;
      config: ConsentToolConfig;
      /** 'older-minor' is what the rescan flags as "deployed config is behind". */
      version: 'current' | 'older-minor' | 'newer-minor';
      /** False when the pasted config was edited after generation. */
      hashMatches: boolean;
    }
  | { ok: false; reason: 'newer-major' | 'older-major' | 'invalid'; version: ConsentConfigVersionStatus; issues: ConsentConfigIssue[] };

/**
 * Full validation. A different major is refused before the schema runs — a
 * newer one because this build cannot read it, an older one because no
 * migration exists yet (when one does, it runs here, before `parse`).
 */
export function parseConsentToolConfig(raw: unknown): ParseConsentToolConfigResult {
  const version = consentConfigVersionStatus(typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined);
  if (version === 'newer-major' || version === 'older-major') {
    return { ok: false, reason: version, version, issues: [{ path: 'version', message: `major differs from ${CONSENT_CONFIG_VERSION}` }] };
  }
  const r = ConsentToolConfigSchema.safeParse(raw);
  if (!r.success) {
    return {
      ok: false,
      reason: 'invalid',
      version,
      issues: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    };
  }
  if (version === 'invalid') throw new Error('unreachable: schema accepted an invalid version');
  // The hash is checked over the config AS DEPLOYED, not the parsed form: parsing strips
  // fields a newer minor added and fills defaults an older minor lacked, and neither is
  // an edit. The generator emits the parsed form, so for its output the two agree.
  const { hash: _h, ...deployed } = raw as Record<string, unknown>;
  return { ok: true, config: r.data, version, hashMatches: createHash('sha256').update(canonicalJson(deployed)).digest('hex') === r.data.hash };
}

// --- editor schema ------------------------------------------------------------------

export const CONSENT_CONFIG_JSON_SCHEMA_ID = 'https://jeffjassky.github.io/complykit/schema/consent-tool-config.schema.json';

/** JSON Schema (draft-07) of the INPUT shape, for editors. Written to schema/ by scripts/emit-consent-config-schema.mjs. */
export function consentToolConfigJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(ConsentToolConfigSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return {
    $schema: s.$schema,
    $id: CONSENT_CONFIG_JSON_SCHEMA_ID,
    title: `complykit consent tool config v${CONSENT_CONFIG_VERSION}`,
    description:
      'Inline configuration of the complykit consent tool, generated from a scan. Hand edits invalidate `hash`; the rescan reports them.',
    ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$schema')),
  };
}
