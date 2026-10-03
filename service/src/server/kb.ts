// The knowledge base, as the service sees it: a thin layer over
// `complykit kb … --dir <kbDir> --json`. The service never imports complykit —
// every read and write is a CLI child process, so the CLI stays the one owner
// of the store's format and rules (agents never confirm, rejects need reasons…).
//
// Three things live here beyond the shell-out:
//   - input validation, so a bad click is a 400 before a process starts and no
//     value can be read as a CLI flag;
//   - a promise chain that serializes mutations, so two quick clicks can't
//     interleave read-modify-write cycles on proposals.json / queue.json;
//   - the one-at-a-time background `kb research` run and its state.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  KB_CATEGORIES,
  type KbCategory,
  type KbConfirmRequest,
  type KbEntry,
  type KbProposal,
  type KbQueueItem,
  type KbResearchRequest,
  type KbResearchState,
  type KbResponse,
} from '../shared/api.js';
import type { ServiceConfig } from './config.js';

/** A KB failure with the HTTP status the route should answer with. */
export class KbError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads and single mutations are quick; research calls a model and searches the web. */
const CLI_TIMEOUT_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 30 * 60_000;
const MAX_STDOUT = 64 * 1024 * 1024;
const STDERR_TAIL = 6;
export const RESEARCH_TOP_DEFAULT = 5;
export const RESEARCH_MAX = 20;

// --- Validation -----------------------------------------------------------------
// Positionals must never start with '-' (node:util parseArgs would take them as
// flags); these patterns guarantee that.

const DOMAIN_RE = /^[a-z0-9_][a-z0-9_.-]{0,252}$/i;
const PROPOSAL_ID_RE = /^[a-z0-9][\w.:-]{0,200}$/i;
const CATEGORY_IDS = new Set<string>(KB_CATEGORIES.map((c) => c.id));

export function isDomain(v: unknown): v is string {
  return typeof v === 'string' && DOMAIN_RE.test(v) && v.includes('.');
}

export function isProposalId(v: unknown): v is string {
  return typeof v === 'string' && PROPOSAL_ID_RE.test(v);
}

/** Optional free text: undefined when absent or blank, 400 when not a string or too long. */
export function optionalText(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new KbError(400, `\`${field}\` must be a string`);
  const t = v.trim();
  if (t.length > max) throw new KbError(400, `\`${field}\` is longer than ${max} characters`);
  return t || undefined;
}

export function requiredText(v: unknown, field: string, max: number, why: string): string {
  const t = optionalText(v, field, max);
  if (!t) throw new KbError(400, `\`${field}\` is required — ${why}`);
  return t;
}

/** The reviewer: a person's name. The CLI refuses agents too; saying so here keeps it a 400. */
export function reviewer(v: unknown): string {
  const by = requiredText(v, 'by', 80, 'the person reviewing');
  if (/^agent[:/]/i.test(by)) throw new KbError(400, 'agents never confirm or reject proposals — a person does');
  return by;
}

export function categoryList(v: unknown): KbCategory[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length) throw new KbError(400, '`categories` must be a non-empty array');
  const bad = v.filter((c) => typeof c !== 'string' || !CATEGORY_IDS.has(c));
  if (bad.length) throw new KbError(400, `unknown category: ${bad.map(String).join(', ')}`);
  return [...new Set(v as KbCategory[])];
}

// --- Child processes --------------------------------------------------------------

interface CliOptions {
  timeoutMs?: number;
  /** Receives the child so a long run can be killed from outside. */
  onSpawn?: (child: ChildProcess) => void;
}

export class KnowledgeBase {
  private chain: Promise<unknown> = Promise.resolve();
  private research: KbResearchState = { running: false, domains: [] };
  private researchChild?: ChildProcess;
  private researchDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ServiceConfig,
    /** Called after anything that changed the store (the SSE `kb` event). */
    private readonly onChange: () => void = () => {},
  ) {}

  get dir(): string {
    return this.config.kbDir;
  }

  researchState(): KbResearchState {
    return structuredClone(this.research);
  }

  // --- reads ----------------------------------------------------------------------
  // Not serialized: the CLI writes by temp file + rename, so a read sees the
  // state before or after a write, never half of one.

  async snapshot(): Promise<KbResponse> {
    const [q, proposals, entries] = await Promise.all([
      this.json<{ dir: string; queue: KbQueueItem[]; counts: KbResponse['counts'] }>(['queue', '--all']),
      this.json<KbProposal[]>(['proposals', '--status', 'all']),
      this.json<KbEntry[]>(['entries']),
    ]);
    return {
      dir: q.dir,
      queue: q.queue,
      counts: q.counts,
      proposals,
      entries,
      researchAvailable: this.config.researchAvailable,
      research: this.researchState(),
    };
  }

  packet(domain: string): Promise<string> {
    if (!isDomain(domain)) return Promise.reject(new KbError(400, 'not a domain'));
    return this.cli(['packet', domain]);
  }

  // --- mutations (serialized) -------------------------------------------------------

  confirm(id: string, req: Omit<KbConfirmRequest, 'by'> & { by: string }): Promise<KbEntry> {
    return this.mutate(async () => {
      await this.openProposal(id);
      const args = ['confirm', id, '--by', req.by];
      if (req.categories) args.push('--category', req.categories.join(','));
      if (req.vendor) args.push('--vendor', req.vendor);
      if (req.owner) args.push('--owner', req.owner);
      if (req.consentApi) args.push('--consent-api', req.consentApi);
      if (req.note) args.push('--note', req.note);
      return this.json<KbEntry>(args);
    });
  }

  reject(id: string, by: string, reason: string): Promise<KbProposal> {
    return this.mutate(async () => {
      await this.openProposal(id);
      return this.json<KbProposal>(['reject', id, '--by', by, '--reason', reason]);
    });
  }

  dismiss(domain: string, note?: string): Promise<void> {
    return this.mutate(async () => {
      const { queue } = await this.json<{ queue: KbQueueItem[] }>(['queue', '--all']);
      if (!queue.some((x) => x.domain === domain)) throw new KbError(404, `${domain} is not in the queue`);
      await this.cli(['dismiss', domain, ...(note ? ['--note', note] : [])]);
    });
  }

  // --- research ---------------------------------------------------------------------

  /** Validate, claim the single research slot, and start the run in the
   *  background. Resolves with the new state once the run has started. */
  async startResearch(req: KbResearchRequest): Promise<KbResearchState> {
    if (!this.config.researchAvailable) {
      throw new KbError(400, 'research needs ANTHROPIC_API_KEY on the server — use “Copy packet” to research by hand');
    }
    if (this.research.running) throw new KbError(409, `research is already running (${this.research.domains.join(', ')})`);
    const prev = this.research;
    // Claimed before the first await, so two quick requests can't both start.
    this.research = { running: true, domains: [], startedAt: new Date().toISOString() };
    let domains: string[];
    try {
      domains = await this.researchTargets(req);
    } catch (err) {
      this.research = prev;
      throw err;
    }
    this.research.domains = domains;
    this.onChange();
    this.researchDone = this.runResearch(domains);
    return this.researchState();
  }

  private async researchTargets(req: KbResearchRequest): Promise<string[]> {
    const { queue } = await this.json<{ queue: KbQueueItem[] }>(['queue']); // open only, ranked
    if (req.domains !== undefined) {
      const wanted = [...new Set(req.domains)];
      const open = new Set(queue.map((x) => x.domain));
      const missing = wanted.filter((d) => !open.has(d));
      if (missing.length) throw new KbError(400, `not open in the queue: ${missing.join(', ')}`);
      return wanted;
    }
    const top = queue.slice(0, req.top ?? RESEARCH_TOP_DEFAULT).map((x) => x.domain);
    if (!top.length) throw new KbError(400, 'nothing open to research');
    return top;
  }

  private async runResearch(domains: string[]): Promise<void> {
    const state = this.research;
    try {
      const out = await this.json<{ model?: string; results: Array<{ domain: string; proposal?: { id: string }; error?: string }> }>(['research', ...domains], {
        timeoutMs: RESEARCH_TIMEOUT_MS,
        onSpawn: (child) => (this.researchChild = child),
      });
      state.model = out.model;
      state.lastResults = out.results.map((r) => ({ domain: r.domain, ...(r.proposal ? { proposalId: r.proposal.id } : {}), ...(r.error ? { error: r.error } : {}) }));
    } catch (err) {
      state.lastError = (err as Error).message;
      state.lastResults = undefined;
    } finally {
      this.researchChild = undefined;
      state.running = false;
      state.finishedAt = new Date().toISOString();
      this.onChange();
    }
  }

  /** Kill a running research child (server shutdown) and wait for it to settle. */
  async stop(graceMs = this.config.killGraceMs): Promise<void> {
    const child = this.researchChild;
    if (child) {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), graceMs);
      t.unref();
    }
    await this.researchDone;
    await this.chain.catch(() => undefined);
  }

  // --- internals ----------------------------------------------------------------------

  /** Run `fn` after every earlier mutation has settled; tell listeners after. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    // The chain carries on after a failure; the caller still sees the error.
    this.chain = run.then(
      () => this.onChange(),
      () => undefined,
    );
    return run;
  }

  /** 404 when there is no such proposal, 409 when it was already reviewed. */
  private async openProposal(id: string): Promise<KbProposal> {
    const list = await this.json<KbProposal[]>(['proposals', '--status', 'all']);
    const p = list.find((x) => x.id === id);
    if (!p) throw new KbError(404, `no proposal ${id}`);
    if (p.status !== 'proposed') throw new KbError(409, `${id} is already ${p.status}`);
    return p;
  }

  private async json<T>(args: string[], opts?: CliOptions): Promise<T> {
    const stdout = await this.cli([...args, '--json'], opts);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new KbError(500, `complykit kb ${args[0]} printed something other than JSON`);
    }
  }

  /** `node <cli> kb <args> --dir <kbDir>` → stdout. Exit 2 is the CLI's "you
   *  asked for something wrong" (400); anything else non-zero is ours (500). */
  private cli(args: string[], { timeoutMs = CLI_TIMEOUT_MS, onSpawn }: CliOptions = {}): Promise<string> {
    const { cliPath, kbDir } = this.config;
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(cliPath)) {
        reject(new KbError(500, `complykit CLI not found at ${cliPath} (build complykit or set COMPLYKIT_CLI)`));
        return;
      }
      const child = spawn(process.execPath, [cliPath, 'kb', ...args, '--dir', kbDir], {
        env: { ...process.env, COMPLYKIT_KB_DIR: kbDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      onSpawn?.(child);
      const out: Buffer[] = [];
      let outBytes = 0;
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > MAX_STDOUT) child.kill('SIGKILL');
        else out.push(c);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => {
        stderr = (stderr + c).slice(-8192);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new KbError(500, `complykit kb ${args[0]}: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const tail = stderr
          .trim()
          .split('\n')
          .slice(-STDERR_TAIL)
          .join('\n')
          .replace(/^complykit: /, '');
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else if (timedOut) reject(new KbError(500, `complykit kb ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
        else if (code === 2) reject(new KbError(400, tail || `complykit kb ${args[0]}: invalid request`));
        else reject(new KbError(500, tail || `complykit kb ${args[0]} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      });
    });
  }
}
