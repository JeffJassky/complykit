import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { KB_ENTRIES, KnowledgeEntry, type KnowledgeEntryInput, type PartyCategory } from '../registry/kb/index.js';
import { QueueItem, Proposal, ProposalBody, type ProposalInput } from './schema.js';
import { rankQueue } from './queue.js';

// The local knowledge-base store: a directory of three JSON files.
//
//   entries.json    confirmed entries (KnowledgeEntryInput[] — the same shape
//                   `property.consent.knowledgeBase.entries` already reads)
//   proposals.json  proposals, with their review outcome
//   queue.json      the research queue
//
// One store per machine by default (~/.complykit/kb) so every site scanned on
// it feeds, and benefits from, the same research. COMPLYKIT_KB_DIR moves it
// (the service keeps it on its volume). Writes are atomic (temp + rename).

export function defaultKbDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPLYKIT_KB_DIR ? path.resolve(env.COMPLYKIT_KB_DIR) : path.join(os.homedir(), '.complykit', 'kb');
}

function readJson<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Cross-process lock: a scan ingesting into the queue, the service confirming,
// and a research run proposing all read-modify-write the same files. A lock
// directory (mkdir is atomic) serializes them; a lock older than STALE_MS is
// from a crashed process and is broken.
const STALE_MS = 30_000;
const WAIT_MS = 15_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function withLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`knowledge-base store ${dir} is locked (another complykit process is writing); try again`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export interface ConfirmEdits {
  vendor?: string;
  owner?: string;
  categories?: PartyCategory[];
  consentApi?: string;
  notes?: string;
}

export class KbStore {
  readonly dir: string;
  constructor(dir: string = defaultKbDir()) {
    this.dir = dir;
  }
  private file(name: 'entries' | 'proposals' | 'queue'): string {
    return path.join(this.dir, `${name}.json`);
  }

  // --- reads ----------------------------------------------------------------

  entries(): KnowledgeEntry[] {
    return readJson(this.file('entries'), z.array(KnowledgeEntry), []);
  }
  proposals(): Proposal[] {
    return readJson(this.file('proposals'), z.array(Proposal), []);
  }
  queue(): QueueItem[] {
    return readJson(this.file('queue'), z.array(QueueItem), []);
  }
  rankedQueue(): QueueItem[] {
    return rankQueue(this.queue());
  }
  /** Confirmed entries as KB input — what a scan layers over the seed. */
  confirmedEntries(): KnowledgeEntryInput[] {
    return this.entries();
  }

  // --- writes ---------------------------------------------------------------

  /** Run a read-modify-write under the store lock (e.g. ingesting a scan). */
  locked<T>(fn: () => T): T {
    return withLock(this.dir, fn);
  }

  saveQueue(q: QueueItem[]): void {
    writeJson(this.file('queue'), rankQueue(q));
  }
  private saveProposals(p: Proposal[]): void {
    writeJson(this.file('proposals'), p);
  }
  private saveEntries(e: KnowledgeEntry[]): void {
    writeJson(this.file('entries'), e);
  }

  /** Record a proposal for a queued domain. Validates sources and categories. */
  propose(domain: string, body: unknown, proposedBy: string, at = new Date().toISOString()): Proposal {
    return withLock(this.dir, () => this._propose(domain, body, proposedBy, at));
  }
  private _propose(domain: string, body: unknown, proposedBy: string, at: string): Proposal {
    const parsed = ProposalBody.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`invalid proposal: ${i?.path.join('.') || '(root)'} — ${i?.message}`);
    }
    const proposals = this.proposals();
    const n = proposals.filter((p) => p.domain === domain).length + 1;
    const input: ProposalInput = { ...parsed.data, id: `p-${domain}-${n}`, domain, status: 'proposed', proposedBy, proposedAt: at };
    const proposal = Proposal.parse(input);
    proposals.push(proposal);
    this.saveProposals(proposals);
    const q = this.queue();
    for (const item of q) {
      if (item.domain === domain && item.status === 'open') {
        item.status = 'proposed';
        item.proposalId = proposal.id;
      }
    }
    this.saveQueue(q);
    return proposal;
  }

  /**
   * A human confirms a proposal (optionally correcting it) — or confirms a seed
   * entry by id. The confirmed entry is written to entries.json and joins the
   * KB on the next scan. Agents never confirm (§4.2): `by` may not be an agent.
   */
  confirm(id: string, by: string, edits: ConfirmEdits = {}, at = new Date().toISOString()): KnowledgeEntry {
    return withLock(this.dir, () => this._confirm(id, by, edits, at));
  }
  private _confirm(id: string, by: string, edits: ConfirmEdits, at: string): KnowledgeEntry {
    if (!by.trim()) throw new Error('confirm needs a reviewer name (--by)');
    if (/^agent[:/]/i.test(by)) throw new Error('agents never confirm their own proposals — a person confirms');
    const proposals = this.proposals();
    const p = proposals.find((x) => x.id === id);
    let entry: KnowledgeEntry;
    if (p) {
      if (p.status === 'confirmed') throw new Error(`${id} is already confirmed`);
      entry = KnowledgeEntry.parse({
        ...p.entry,
        ...stripUndefined(edits),
        provenance: { proposedBy: p.proposedBy, proposedAt: p.proposedAt, confirmedBy: by, confirmedAt: at, sources: p.sources },
      });
      p.status = 'confirmed';
      p.reviewedBy = by;
      p.reviewedAt = at;
      if (Object.keys(stripUndefined(edits)).length) p.reviewNote = `corrected on confirm: ${Object.keys(stripUndefined(edits)).join(', ')}`;
      this.saveProposals(proposals);
      const q = this.queue();
      for (const item of q) if (item.domain === p.domain && item.status !== 'dismissed') item.status = 'resolved';
      this.saveQueue(q);
    } else {
      const local = this.entries().find((e) => e.id === id);
      const seed = local ?? KB_ENTRIES.find((e) => e.id === id);
      if (!seed) throw new Error(`no proposal or entry with id ${id}`);
      entry = KnowledgeEntry.parse({
        ...seed,
        ...stripUndefined(edits),
        provenance: { ...seed.provenance, confirmedBy: by, confirmedAt: at },
      });
      // Confirming a drifted entry closes its drift item.
      const q = this.queue();
      for (const item of q) if (item.kind === 'drift' && item.entryId === id && item.status !== 'dismissed') item.status = 'resolved';
      this.saveQueue(q);
    }
    // The same vendor is often proposed once per domain it uses (marketo.net and
    // mktoresp.com): confirming a second proposal with an existing id MERGES —
    // hosts, stores and sources accumulate — rather than dropping the first's hosts.
    const prev = p ? this.entries().find((e) => e.id === entry.id) : undefined;
    if (prev) {
      entry = KnowledgeEntry.parse({
        ...entry,
        match: { ...entry.match, hosts: [...new Set([...prev.match.hosts, ...entry.match.hosts])], path: prev.match.path === entry.match.path ? entry.match.path : undefined },
        sends: [...new Set([...prev.sends, ...entry.sends])],
        stores: [...prev.stores, ...entry.stores.filter((s) => !prev.stores.some((x) => x.name === s.name && x.kind === s.kind))],
        provenance: { ...entry.provenance, sources: [...new Set([...prev.provenance.sources, ...entry.provenance.sources])] },
      });
    }
    const entries = this.entries().filter((e) => e.id !== entry.id);
    entries.push(entry);
    this.saveEntries(entries);
    return entry;
  }

  reject(id: string, by: string, reason: string, at = new Date().toISOString()): Proposal {
    return withLock(this.dir, () => this._reject(id, by, reason, at));
  }
  private _reject(id: string, by: string, reason: string, at: string): Proposal {
    if (!by.trim()) throw new Error('reject needs a reviewer name (--by)');
    if (!reason.trim()) throw new Error('reject needs a reason — the next researcher reads it');
    const proposals = this.proposals();
    const p = proposals.find((x) => x.id === id);
    if (!p) throw new Error(`no proposal ${id}`);
    if (p.status !== 'proposed') throw new Error(`${id} is already ${p.status}`);
    p.status = 'rejected';
    p.reviewedBy = by;
    p.reviewedAt = at;
    p.reviewNote = reason;
    this.saveProposals(proposals);
    // Back to open, so it can be researched again with the rejection in view.
    const q = this.queue();
    for (const item of q) if (item.proposalId === id && item.status === 'proposed') item.status = 'open';
    this.saveQueue(q);
    return p;
  }

  /** Take a domain off the queue without an entry (noise, the site's own infra). */
  dismiss(domain: string, note: string): QueueItem[] {
    return withLock(this.dir, () => this._dismiss(domain, note));
  }
  private _dismiss(domain: string, note: string): QueueItem[] {
    const q = this.queue();
    const hit = q.filter((x) => x.domain === domain);
    if (!hit.length) throw new Error(`${domain} is not in the queue`);
    for (const item of hit) {
      item.status = 'dismissed';
      item.note = note || undefined;
    }
    this.saveQueue(q);
    return hit;
  }

  /** Remove a confirmed local entry (it stops being recognized on the next scan). */
  removeEntry(id: string): boolean {
    return withLock(this.dir, () => this._removeEntry(id));
  }
  private _removeEntry(id: string): boolean {
    const entries = this.entries();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    this.saveEntries(next);
    return true;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}
