import { z } from 'zod';
import { KnowledgeEntry, PartyCategory, ConsentDecoder } from '../registry/kb/index.js';

// The research workflow's records (plans/consent-design.md §4.2). Three kinds:
//
//   queue      — every party a scan could not explain (or that drifted from its
//                entry), aggregated per registrable domain ACROSS sites and runs,
//                with the evidence a researcher needs.
//   proposals  — an agent's (or a person's) proposed entry, with cited sources,
//                waiting for a human. Never used for recognition.
//   entries    — confirmed entries. These, and only these, join the knowledge
//                base on the next scan.
//
// The queue names client sites, so the store lives outside the repository
// (default ~/.complykit/kb — this repository is public).

export const QueueKind = z.enum(['unrecognized', 'drift']);
export type QueueKind = z.infer<typeof QueueKind>;

export const QueueStatus = z.enum(['open', 'proposed', 'resolved', 'dismissed']);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const QueueItem = z.object({
  /** Registrable domain — the research unit (a vendor is researched once). */
  domain: z.string(),
  kind: QueueKind,
  status: QueueStatus.default('open'),
  /** Latest reason from a scan, e.g. "behaves like a tracker (sets id cookie)". */
  reason: z.string(),
  /** For drift: the entry it drifted from. */
  entryId: z.string().optional(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** Sites (hosts) it was seen on — the ranking signal: a vendor on many sites first. */
  sites: z.array(z.string()).default([]),
  runs: z.number().int().default(0),
  requests: z.number().int().default(0),
  hosts: z.array(z.string()).default([]),
  behavesLikeTracker: z.boolean().default(false),
  trackerSignals: z.array(z.string()).default([]),
  sends: z.array(z.string()).default([]),
  stores: z.array(z.object({ name: z.string(), kind: z.string(), lifetimeDays: z.number().nullable() })).default([]),
  sources: z.array(z.string()).default([]),
  loadedBy: z.array(z.string()).default([]),
  samples: z.array(z.string()).default([]),
  /** Scenario phases it was seen in, e.g. "before-choice", "after-reject". */
  phases: z.array(z.string()).default([]),
  /** Set when status leaves 'open'. */
  proposalId: z.string().optional(),
  note: z.string().optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

/** What a researcher hands back. The entry's provenance is filled in by the store. */
export const ProposedEntry = KnowledgeEntry.omit({ provenance: true }).extend({
  categories: z.array(PartyCategory).min(1),
  decoder: ConsentDecoder.default('none'),
});
export type ProposedEntry = z.infer<typeof ProposedEntry>;

export const ProposalBody = z.object({
  entry: ProposedEntry,
  /** How it was established: 'researched' (read the vendor's sources — cited,
   *  required) or 'model-knowledge' (classified from what a model already knows
   *  plus complykit's observations, with a stated confidence; no citations). */
  basis: z.enum(['researched', 'model-knowledge']).default('researched'),
  /** Cited sources — required for a researched proposal (§4.2). */
  sources: z.array(z.string().url()).default([]),
  /** Why these categories, in two or three sentences, citing the sources. */
  rationale: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  /** Where what complykit observed disagrees with the vendor's documentation. */
  disagreements: z.array(z.string()).default([]),
  /** The domain is the site's own infrastructure, not an outside vendor. */
  firstParty: z.boolean().default(false),
  /** 0–100, for model-knowledge classifications. */
  confidencePct: z.number().min(0).max(100).optional(),
}).refine((b) => b.basis !== 'researched' || b.sources.length > 0, { message: 'a researched proposal needs at least one cited source', path: ['sources'] });
export type ProposalBody = z.infer<typeof ProposalBody>;

export const ProposalStatus = z.enum(['proposed', 'confirmed', 'rejected']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const Proposal = ProposalBody.innerType().extend({
  id: z.string(), // 'p-<domain>-<n>'
  domain: z.string(),
  status: ProposalStatus.default('proposed'),
  proposedBy: z.string(), // 'agent:<model>' | a person
  proposedAt: z.string(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
});
export type Proposal = z.infer<typeof Proposal>;
export type ProposalInput = z.input<typeof Proposal>;
