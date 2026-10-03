import { PartyCategory, ConsentDecoder } from '../registry/kb/index.js';
import type { Proposal, QueueItem } from './schema.js';

// The research brief (plans/consent-design.md §4.2 step 2): what complykit
// observed about one domain, the vocabulary an entry must use, and the rules a
// researcher follows. The same text drives the API researcher and the manual
// packet (`complykit kb packet`) a person or a coding agent fills in. Pure.

const CATEGORY_MEANING: Record<PartyCategory, string> = {
  necessary: 'needed for the service the visitor asked for (cart, login, load balancing)',
  functional: 'remembers visitor choices or adds a feature the visitor uses',
  analytics: 'measures visits and behavior',
  advertising: 'ads, retargeting, conversion tracking, audience building',
  'session-recording': 'records clicks, scrolls, keystrokes or replays sessions',
  chat: 'live chat or support widget',
  'identity-resolution': 'links the visitor to an identity across sites or devices',
  fingerprinting: 'identifies the device from its characteristics',
  embed: 'third-party content embedded in the page (video, maps, social posts)',
  fonts: 'web font delivery',
  captcha: 'bot / abuse protection challenge',
  cdn: 'serves static files only, no visitor data use',
  payments: 'payment processing',
  'tag-manager': 'loads other tags',
  consent: 'the consent tool itself',
  'error-monitoring': 'error and performance reporting',
  'marketing-email': 'email / SMS marketing capture and attribution',
  reviews: 'product reviews / ratings widget',
};

// rules/tracking/fields.ts FieldKind — what complykit can observe in a request.
const FIELD_KINDS = ['page-address', 'page-title', 'browser-id', 'click-id', 'form-input', 'search-term', 'hashed-email', 'event-name', 'identifier'];

export const RESEARCH_SYSTEM = `You research one outside party that complykit (a consent and tracking auditor) saw on websites, and propose a knowledge-base entry for it.

Rules:
- Find who operates the domain and what the script/endpoint is. Prefer the vendor's own documentation, developer docs, privacy policy and cookie list. Every claim that sets a category must be supported by a source you cite (full URLs you actually read).
- What complykit observed outranks documentation. If the docs say one thing and the observations show another (e.g. an undocumented cookie, data sent before consent that the docs say waits), record it in "disagreements" — do not resolve it in the vendor's favor.
- Categories describe what the party does with visitor data, not what the vendor markets. A "chat" widget that also builds ad audiences gets both.
- If the domain is clearly the site's own infrastructure (its own CDN, API, or a white-label of the site), set firstParty true and explain.
- If you cannot establish what it is, say so: confidence "low", and the categories you can defend from observations alone.
- Entry id: '<vendor>.<product>' in lower case, e.g. 'klaviyo.onsite'. match.hosts: registrable domains or host suffixes the vendor uses (not the site's). Use match.path only when the vendor shares a host with unrelated services.
- consentApi: how a consent tool tells this vendor the visitor's choice, or "none — must be held back" if it has none.
- Call propose_entry exactly once with the result.`;

/** The JSON schema of propose_entry's input — mirrors ProposalBody. */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  required: ['entry', 'sources', 'rationale', 'confidence'],
  properties: {
    entry: {
      type: 'object',
      required: ['id', 'vendor', 'match', 'categories'],
      properties: {
        id: { type: 'string' },
        vendor: { type: 'string', description: 'Product name, e.g. "Klaviyo onsite"' },
        owner: { type: 'string', description: 'Legal entity, e.g. "Klaviyo, Inc."' },
        match: {
          type: 'object',
          required: ['hosts'],
          properties: { hosts: { type: 'array', items: { type: 'string' }, minItems: 1 }, path: { type: 'string', description: 'regex source over the request path' } },
        },
        categories: { type: 'array', items: { type: 'string', enum: PartyCategory.options }, minItems: 1 },
        sends: { type: 'array', items: { type: 'string', enum: FIELD_KINDS } },
        stores: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', description: 'regex source over the cookie/storage key' }, kind: { type: 'string', enum: ['cookie', 'local', 'session'] }, lifetimeDays: { type: 'number' } },
          },
        },
        consentApi: { type: 'string' },
        decoder: { type: 'string', enum: ConsentDecoder.options },
        restrictedMode: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    sources: { type: 'array', items: { type: 'string' }, minItems: 1 },
    rationale: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    disagreements: { type: 'array', items: { type: 'string' } },
    firstParty: { type: 'boolean' },
  },
} as const;

/** The per-domain brief: observations + prior rejected attempts. */
export function researchBrief(item: QueueItem, prior: readonly Proposal[] = []): string {
  const l: string[] = [];
  l.push(`# Research: ${item.domain}`);
  l.push('');
  l.push(item.kind === 'drift' ? `Kind: drift — recognized as entry \`${item.entryId}\`, but it behaved differently: ${item.reason}. Propose a corrected entry (same id).` : `Kind: unrecognized — ${item.reason}.`);
  l.push('');
  l.push('## What complykit observed');
  l.push(`- Seen on ${item.sites.length} site(s) across ${item.runs} run(s), ${item.requests} request(s). Sites: ${item.sites.slice(0, 10).join(', ')}`);
  l.push(`- Hosts: ${item.hosts.join(', ') || '—'}`);
  if (item.samples.length) {
    l.push('- Sample requests (query values removed):');
    for (const s of item.samples) l.push(`  - ${s}`);
  }
  l.push(`- Data observed in its requests: ${item.sends.join(', ') || 'nothing classified'}`);
  if (item.stores.length) l.push(`- Stored on the device: ${item.stores.map((s) => `${s.name} (${s.kind}${s.lifetimeDays != null ? `, ${s.lifetimeDays}d` : ''})`).join(', ')}`);
  l.push(`- Tracker signals: ${item.trackerSignals.join(', ') || 'none'}`);
  l.push(`- How it got on the page: ${item.sources.join(', ') || 'unknown'}${item.loadedBy.length ? `; loaded by ${item.loadedBy.slice(0, 4).join(', ')}` : ''}`);
  l.push(`- Seen during: ${item.phases.join(', ') || '—'}`);
  const rejected = prior.filter((p) => p.domain === item.domain && p.status === 'rejected');
  if (rejected.length) {
    l.push('');
    l.push('## Earlier proposals a reviewer rejected — do not repeat their mistakes');
    for (const p of rejected) l.push(`- ${p.entry.vendor} [${p.entry.categories.join(', ')}] — rejected by ${p.reviewedBy}: ${p.reviewNote}`);
  }
  l.push('');
  l.push('## Category vocabulary');
  for (const c of PartyCategory.options) l.push(`- ${c}: ${CATEGORY_MEANING[c]}`);
  l.push('');
  l.push(`Field kinds for "sends": ${FIELD_KINDS.join(', ')}`);
  return l.join('\n');
}

/** The manual packet: system rules + brief + the shape to hand back. */
export function researchPacket(item: QueueItem, prior: readonly Proposal[] = []): string {
  return [
    RESEARCH_SYSTEM.replace('Call propose_entry exactly once with the result.', 'Write the result as JSON matching the schema below, and import it with `complykit kb propose <domain> --file <json> --by <your name or agent:model>`.'),
    '',
    researchBrief(item, prior),
    '',
    '## Result schema (JSON)',
    '```json',
    JSON.stringify(PROPOSAL_JSON_SCHEMA, null, 2),
    '```',
  ].join('\n');
}
