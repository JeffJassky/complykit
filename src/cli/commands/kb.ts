import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readTrackingEvaluation } from '../../record/index.js';
import { buildKnowledgeBase, type PartyCategory } from '../../registry/index.js';
import { PartyCategory as PartyCategorySchema } from '../../registry/kb/index.js';
import { KbStore, defaultKbDir, ingestEvaluation, researchItem, researchPacket, type QueueItem, type Proposal } from '../../research/index.js';

export const KB_HELP = `complykit kb — the knowledge base and its research workflow

Every consent scan adds the parties it could not recognize (and recognized ones
that behaved differently than their entry) to a research queue. Each is
researched once per vendor — by the API, or by hand from a packet — into a
PROPOSAL with cited sources. A person confirms or rejects it. Confirmed entries
are recognized on every later scan of every site.

  kb queue [--all] [--limit N]         open queue, most widespread first
  kb packet <domain>                   research brief to fill in by hand / with an agent
  kb research [domain…] [--top N]      research with the Anthropic API (ANTHROPIC_API_KEY;
                                       model: --model or COMPLYKIT_RESEARCH_MODEL)
  kb propose <domain> --file <json> --by <who>
                                       import a proposal (shape: see kb packet)
  kb proposals [--status s]            proposals (proposed | confirmed | rejected | all)
  kb show <proposal-id | domain>       one proposal or queue item in full
  kb confirm <id> --by <who> [--category a,b] [--vendor ..] [--owner ..]
                 [--consent-api ..] [--note ..]
                                       confirm a proposal (optionally corrected) or a seed entry
  kb reject <id> --by <who> --reason <why>
  kb dismiss <domain> [--note ..]      drop from the queue without an entry
  kb entries                           confirmed local entries
  kb remove <entry-id>                 delete a confirmed local entry
  kb ingest <run-dir…>                 add earlier consent runs to the queue

  --dir <path>    store location (default: COMPLYKIT_KB_DIR or ~/.complykit/kb)
  --json          machine-readable output (queue, proposals, entries, show, research)

--by defaults to COMPLYKIT_REVIEWER. Agents never confirm their own proposals.`;

const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
};
const err = (s: string): number => {
  process.stderr.write(`${s}\n`);
  return 2;
};

function queueLine(q: QueueItem): string {
  const status = q.status === 'open' ? '' : ` [${q.status}${q.proposalId ? ` ${q.proposalId}` : ''}]`;
  const kind = q.kind === 'drift' ? ` drift(${q.entryId})` : '';
  return `${q.domain.padEnd(32)} ${String(q.sites.length).padStart(3)} site(s) ${String(q.requests).padStart(6)} req  ${q.behavesLikeTracker ? 'tracker  ' : '         '}${kind}${status}\n    ${q.reason}`;
}

function proposalText(p: Proposal): string {
  const e = p.entry;
  return [
    `${p.id}  [${p.status}]  ${p.domain}`,
    `  ${e.vendor}${e.owner ? ` — ${e.owner}` : ''}  (id ${e.id})`,
    `  categories: ${e.categories.join(', ')}   confidence: ${p.confidence}${p.firstParty ? '   FIRST PARTY' : ''}`,
    `  hosts: ${e.match.hosts.join(', ')}${e.match.path ? `  path: ${e.match.path}` : ''}`,
    e.sends.length ? `  sends: ${e.sends.join(', ')}` : '',
    e.stores.length ? `  stores: ${e.stores.map((s) => s.name).join(', ')}` : '',
    e.consentApi ? `  consent API: ${e.consentApi}` : '',
    `  rationale: ${p.rationale}`,
    p.disagreements.length ? `  observed vs documented:\n${p.disagreements.map((d) => `    - ${d}`).join('\n')}` : '',
    `  sources:\n${p.sources.map((s) => `    - ${s}`).join('\n')}`,
    `  proposed by ${p.proposedBy} at ${p.proposedAt}${p.reviewedBy ? `; ${p.status} by ${p.reviewedBy} at ${p.reviewedAt}${p.reviewNote ? ` — ${p.reviewNote}` : ''}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function cmdKb(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help') {
    out(KB_HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      limit: { type: 'string' },
      top: { type: 'string' },
      model: { type: 'string' },
      file: { type: 'string' },
      by: { type: 'string' },
      status: { type: 'string' },
      category: { type: 'string' },
      vendor: { type: 'string' },
      owner: { type: 'string' },
      'consent-api': { type: 'string' },
      note: { type: 'string' },
      reason: { type: 'string' },
    },
    allowPositionals: true,
  });
  const store = new KbStore(values.dir ? path.resolve(values.dir) : defaultKbDir());
  const by = values.by ?? process.env.COMPLYKIT_REVIEWER ?? '';
  const json = (v: unknown): number => {
    out(JSON.stringify(v, null, 2));
    return 0;
  };

  switch (sub) {
    case 'queue': {
      const all = store.rankedQueue();
      const q = values.all ? all : all.filter((x) => x.status === 'open');
      const limited = values.limit ? q.slice(0, Number(values.limit)) : q;
      if (values.json) return json({ dir: store.dir, queue: limited, counts: countBy(all) });
      if (!q.length) {
        out(all.length ? `queue clear (${all.length} item(s) proposed/resolved/dismissed — kb queue --all).` : `queue empty — run a consent scan first. (store: ${store.dir})`);
        return 0;
      }
      out(`${q.length} open of ${all.length} (store: ${store.dir})\n`);
      for (const item of limited) out(queueLine(item));
      return 0;
    }

    case 'packet': {
      const item = findItem(store, positionals[0]);
      if (!item) return err(`not in the queue: ${positionals[0] ?? '(no domain)'}`);
      out(researchPacket(item, store.proposals()));
      return 0;
    }

    case 'research': {
      const open = store.rankedQueue().filter((x) => x.status === 'open');
      const targets = positionals.length
        ? positionals.map((d) => findItem(store, d) ?? d)
        : open.slice(0, Number(values.top ?? 5));
      if (!targets.length) {
        out('nothing open to research.');
        return 0;
      }
      const { createAnthropicResearcher } = await import('../../judge/client.js');
      const { researcher, model } = await createAnthropicResearcher({ model: values.model });
      const results: Array<{ domain: string; proposal?: Proposal; error?: string }> = [];
      for (const t of targets) {
        if (typeof t === 'string') {
          results.push({ domain: t, error: 'not in the queue' });
          continue;
        }
        if (!values.json) out(`researching ${t.domain} (${model})…`);
        try {
          const { proposal, searches } = await researchItem(store, t, researcher);
          results.push({ domain: t.domain, proposal });
          if (!values.json) out(`${proposalText(proposal)}\n  (${searches} web search(es))\n`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          results.push({ domain: t.domain, error: message });
          if (!values.json) process.stderr.write(`  ${t.domain}: ${message}\n`);
        }
      }
      if (values.json) return json({ model, results });
      out(`review with: complykit kb proposals   ·   complykit kb confirm <id> --by <you>`);
      return results.some((r) => r.error) ? 1 : 0;
    }

    case 'propose': {
      const domain = positionals[0];
      if (!domain || !values.file) return err('usage: kb propose <domain> --file <json> --by <who>');
      if (!by) return err('kb propose needs --by (who proposed it: a name, or agent:<model>)');
      const body = JSON.parse(fs.readFileSync(path.resolve(values.file), 'utf8'));
      const p = store.propose(domain, body, by);
      if (values.json) return json(p);
      out(proposalText(p));
      return 0;
    }

    case 'proposals': {
      const status = values.status ?? 'proposed';
      const list = store.proposals().filter((p) => status === 'all' || p.status === status);
      if (values.json) return json(list);
      if (!list.length) {
        out(`no ${status === 'all' ? '' : `${status} `}proposals.`);
        return 0;
      }
      out(list.map(proposalText).join('\n\n'));
      return 0;
    }

    case 'show': {
      const key = positionals[0];
      if (!key) return err('usage: kb show <proposal-id | domain>');
      const p = store.proposals().find((x) => x.id === key);
      const items = store.queue().filter((x) => x.domain === key);
      const props = store.proposals().filter((x) => x.domain === key);
      if (values.json) return json({ proposal: p, queue: items, proposals: props });
      if (p) out(proposalText(p));
      for (const item of items) out(`${queueLine(item)}\n    hosts: ${item.hosts.join(', ')}\n    samples:\n${item.samples.map((s) => `      ${s}`).join('\n')}\n    sites: ${item.sites.join(', ')}`);
      if (!p) for (const x of props) out(`\n${proposalText(x)}`);
      if (!p && !items.length) return err(`nothing called ${key}`);
      return 0;
    }

    case 'confirm': {
      const id = positionals[0];
      if (!id) return err('usage: kb confirm <proposal-id | entry-id> --by <who>');
      if (!by) return err('kb confirm needs --by (the person confirming) or COMPLYKIT_REVIEWER');
      let categories: PartyCategory[] | undefined;
      if (values.category) {
        const cats = values.category.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = cats.filter((c) => !PartyCategorySchema.safeParse(c).success);
        if (bad.length) return err(`unknown category: ${bad.join(', ')} (${PartyCategorySchema.options.join(', ')})`);
        categories = cats as PartyCategory[];
      }
      const entry = store.confirm(id, by, { categories, vendor: values.vendor, owner: values.owner, consentApi: values['consent-api'], notes: values.note });
      if (values.json) return json(entry);
      out(`confirmed ${entry.id} (${entry.vendor}: ${entry.categories.join(', ')}) — recognized from the next scan on.`);
      return 0;
    }

    case 'reject': {
      const id = positionals[0];
      if (!id || !values.reason) return err('usage: kb reject <proposal-id> --by <who> --reason <why>');
      if (!by) return err('kb reject needs --by or COMPLYKIT_REVIEWER');
      const p = store.reject(id, by, values.reason);
      if (values.json) return json(p);
      out(`rejected ${p.id}; ${p.domain} is open again.`);
      return 0;
    }

    case 'dismiss': {
      const domain = positionals[0];
      if (!domain) return err('usage: kb dismiss <domain> [--note why]');
      store.dismiss(domain, values.note ?? '');
      out(`dismissed ${domain}.`);
      return 0;
    }

    case 'entries': {
      const entries = store.entries();
      if (values.json) return json(entries);
      if (!entries.length) {
        out(`no confirmed local entries yet (store: ${store.dir}).`);
        return 0;
      }
      for (const e of entries) out(`${e.id.padEnd(32)} ${e.vendor} — ${e.categories.join(', ')}  (confirmed by ${e.provenance.confirmedBy} ${e.provenance.confirmedAt?.slice(0, 10)})`);
      return 0;
    }

    case 'remove': {
      const id = positionals[0];
      if (!id) return err('usage: kb remove <entry-id>');
      if (!store.removeEntry(id)) return err(`no local entry ${id}`);
      out(`removed ${id}.`);
      return 0;
    }

    case 'ingest': {
      if (!positionals.length) return err('usage: kb ingest <run-dir…>');
      const kb = buildKnowledgeBase({ extra: store.confirmedEntries() });
      let added = 0;
      let updated = 0;
      for (const p of positionals) {
        const dir = path.resolve(p.endsWith('.json') ? path.dirname(p) : p);
        const ev = readTrackingEvaluation(dir);
        if (!ev) {
          process.stderr.write(`  no tracking evaluation in ${dir}\n`);
          continue;
        }
        const res = ingestEvaluation(store, ev, kb, ev.finishedAt);
        added += res.added.length;
        updated += res.updated.length;
      }
      out(`queue: ${added} new, ${updated} updated (store: ${store.dir}).`);
      return 0;
    }

    default:
      return err(`unknown kb subcommand: ${sub}\n\n${KB_HELP}`);
  }
}

function findItem(store: KbStore, domain: string | undefined): QueueItem | undefined {
  if (!domain) return undefined;
  const q = store.rankedQueue();
  return q.find((x) => x.domain === domain && x.status === 'open') ?? q.find((x) => x.domain === domain);
}

function countBy(q: QueueItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const x of q) c[x.status] = (c[x.status] ?? 0) + 1;
  return c;
}
