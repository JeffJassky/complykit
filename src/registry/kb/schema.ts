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

export const KnowledgeEntry = z.object({
  id: z.string().min(1), // 'meta.pixel'
  vendor: z.string().min(1), // 'Meta Pixel'
  owner: z.string().optional(), // 'Meta Platforms, Inc.'
  match: z.object({
    // Registrable-domain or host suffixes: 'facebook.com' matches www.facebook.com.
    hosts: z.array(z.string().min(1)).min(1),
    // Optional path regex source; when set, the request path must match too.
    path: z.string().optional(),
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

/** Categories courts treat as wiretap-relevant (contents or identity). */
export const WIRETAP_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'session-recording',
  'chat',
  'identity-resolution',
  'advertising',
]);

/** Sale/share under US state laws: cross-context behavioral advertising. */
export const SALE_SHARE_CATEGORIES: ReadonlySet<PartyCategory> = new Set<PartyCategory>([
  'advertising',
  'identity-resolution',
]);
