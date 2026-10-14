import { z } from 'zod';

// Knowledge base entries (plans/consent-design.md §4.1): one per vendor or flow
// signature, not per site. Pure data, versioned (KB_VERSION) and stamped into
// every evaluation so a recognition means what the KB meant at that version.
//
// Provenance is load-bearing: `confirmedBy` is set only by a human (§4.2 — agents
// never confirm their own proposals). Seed entries shipped with complykit are
// proposals until someone confirms them, and the report says so.

export const PartyCategory = z.enum([
  'necessary',
  'functional',
  'analytics',
  'advertising',
  'session-recording',
  'chat',
  'identity-resolution',
  'fingerprinting',
  'embed',
  'fonts',
  'captcha',
  'cdn',
  'payments',
  'tag-manager',
  'consent',
  'error-monitoring',
  'marketing-email',
  'reviews',
]);
export type PartyCategory = z.infer<typeof PartyCategory>;

export const ConsentDecoder = z.enum(['google', 'meta', 'tiktok', 'microsoft', 'iab', 'none']);
export type ConsentDecoder = z.infer<typeof ConsentDecoder>;

// How a tag is controlled (plans/client-consent-design.md §2). Data for the
// client adapters and the compatibility verdict, not display text (that stays
// in `consentApi`). Gating the load works for every tag, so it isn't recorded;
// what varies per vendor is recorded here, each fact with the vendor doc it
// rests on. An absent `api` means no documented consent API: gate the load.

/** A vendor's documented runtime consent call. Strings are the JS to run. */
export const ControlApi = z.object({
  name: z.string().min(1), // 'Google Consent Mode v2'
  // Placed BEFORE the tag loads so it starts denied (gtag consent default,
  // ttq.holdConsent). Absent when the vendor documents none.
  hold: z.string().optional(),
  grant: z.string().min(1),
  revoke: z.string().min(1),
  // What the running tag does once denied/revoked, per the vendor's docs:
  // 'stops' — no further collection; 'cookieless' — keeps sending pings
  // without its identifiers (still requests before consent); 'stops-storage'
  // — stops its cookies, requests may continue; 'unknown' — docs are silent.
  afterRevoke: z.enum(['stops', 'cookieless', 'stops-storage', 'unknown']),
  sources: z.array(z.string().url()).min(1),
});
export type ControlApi = z.infer<typeof ControlApi>;

export const TagControl = z.object({
  api: ControlApi.optional(),
  // Restricted / limited data processing (Google rdp, Meta LDU): how to turn it on.
  restrictedMode: z
    .object({ name: z.string().min(1), set: z.string().min(1), sources: z.array(z.string().url()).min(1) })
    .optional(),
  // Markup in the vendor's official install snippet that fires without script,
  // so type="text/plain" gating does not hold it: a <noscript><img> pixel, or
  // an <iframe> (GTM's noscript iframe; an embed that IS an iframe). 'none':
  // the snippet has no such fallback. Absent: no site-installed snippet
  // (loaded by a platform or app) or not established.
  snippetLeak: z.enum(['noscript-img', 'iframe', 'none']).optional(),
  // Its script loads other vendors (tag manager, widget platform, ad exchange
  // syncing to partners): gating it gates them, and what it loads needs its
  // own control.
  loadsOthers: z.boolean().optional(),
  // Part of a platform (e.g. 'shopify'): site code can't gate its load; only
  // the platform's own consent API controls it.
  platform: z.string().optional(),
  // IAB TCF / GPP is the only consent signal (ad-tech SSPs, exchanges).
  tcf: z
    .object({ vendorId: z.number().int().positive().optional(), gpp: z.boolean().optional(), sources: z.array(z.string().url()).min(1) })
    .optional(),
  notes: z.string().optional(),
  // Basis for snippetLeak / loadsOthers / platform, and for an absent api.
  sources: z.array(z.string().url()).min(1),
});
export type TagControl = z.infer<typeof TagControl>;

export const KnowledgeEntry = z.object({
  id: z.string().min(1), // 'meta.pixel'
  vendor: z.string().min(1), // 'Meta Pixel'
  owner: z.string().optional(), // 'Meta Platforms, Inc.'
  match: z.object({
    // Registrable-domain or host suffixes: 'facebook.com' matches www.facebook.com.
    hosts: z.array(z.string().min(1)).min(1),
    // Optional path regex source; when set, the request path must match too.
    path: z.string().optional(),
    // Regex sources over inline <script> bodies in served HTML (static markup
    // inspection): the vendor's install snippet — 'fbq(', 'ttq.load(' — or its
    // tag-id shape. Hosts named inside a snippet are matched through `hosts`.
    inline: z.array(z.string().min(1)).optional(),
  }),
  categories: z.array(PartyCategory).min(1),
  // Field kinds this vendor is documented/observed to send (vocabulary: see
  // rules/tracking/fields.ts): 'page-address', 'browser-id', 'hashed-email', …
  sends: z.array(z.string()).default([]),
  stores: z
    .array(
      z.object({
        name: z.string(), // regex source over the cookie/storage key
        kind: z.enum(['cookie', 'local', 'session']).default('cookie'),
        lifetimeDays: z.number().optional(),
      }),
    )
    .default([]),
  // How a consent tool tells it the choice — or 'none — must be held back'.
  consentApi: z.string().optional(),
  decoder: ConsentDecoder.default('none'),
  // Has a restricted / limited data mode (Google rdp, Meta LDU) — used for the
  // US opt-out finding: restricted traffic is needs-review, not violation.
  restrictedMode: z.string().optional(),
  // How the tag is controlled, as data (see TagControl).
  control: TagControl.optional(),
  notes: z.string().optional(),
  provenance: z.object({
    proposedBy: z.string(), // 'complykit-seed' | 'agent:<model>' | a person
    proposedAt: z.string(),
    confirmedBy: z.string().optional(),
    confirmedAt: z.string().optional(),
    sources: z.array(z.string().url()).default([]),
  }),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;
export type KnowledgeEntryInput = z.input<typeof KnowledgeEntry>;

/** Categories that need prior consent in the EU/UK and count as tracking. */
export const CONSENT_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'analytics',
  'advertising',
  'session-recording',
  'identity-resolution',
  'fingerprinting',
  'marketing-email',
]);

/** Categories whose need for consent depends on how they're used (embeds, chat,
 *  fonts): findings about them are needs-review, never violation. */
export const CONTEXT_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'chat',
  'embed',
  'fonts',
  'functional',
  'reviews',
  'error-monitoring',
]);

/** Categories courts treat as wiretap-relevant (contents or identity). Analytics joined 2026-10-09:
 *  CIPA §638.51 "pen register" suits name analytics scripts that send the IP address and page
 *  address, and the posture accepts no litigation exposure (plans/research-consent-law.md). */
export const WIRETAP_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'session-recording',
  'chat',
  'identity-resolution',
  'advertising',
  'analytics',
]);

/** Sale/share under US state laws: cross-context behavioral advertising. */
export const SALE_SHARE_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'advertising',
  'identity-resolution',
]);
