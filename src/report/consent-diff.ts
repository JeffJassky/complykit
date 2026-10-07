import type { ConsentReportModel } from './consent-model.js';
import { escapeHtml as esc } from './human.js';
import type { TrackingEvaluation } from '../record/index.js';
import type { ConsentRunDiff } from '../../types/index.js';

/** The site workspace applied to a consent run (src/site-workspace.ts). */
export type SiteWorkspaceRecord = NonNullable<TrackingEvaluation['siteWorkspace']>;

// Run-to-run diff of two consent evaluations of the same site (ticket C3; the
// `diff` machinery of consent-design M10). diff.ts compares two runs' findings
// by fingerprint for the CI gate; this compares what a site owner reads: which
// outside parties appeared or went away, which location verdicts changed, and
// which behavior-matrix checks flipped. Pure: two report models in, data out.
//
// A flip to "match" is a change in what this scan observed, never "fixed" or
// "compliant"; a flip to "unknown"/"not tested" is reported as a lost check.

export type { ConsentRunDiff };
export type PartyRef = ConsentRunDiff['parties']['added'][number];

const ref = (p: ConsentReportModel['inventory'][number]): PartyRef => ({ partyId: p.partyId, label: p.label, domain: p.domain, categories: [...p.categories] });
const same = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function diffConsentModels(base: ConsentReportModel, head: ConsentReportModel): ConsentRunDiff {
  const baseParties = new Map(base.inventory.map((p) => [p.partyId, p]));
  const headParties = new Map(head.inventory.map((p) => [p.partyId, p]));
  const added = head.inventory.filter((p) => !baseParties.has(p.partyId)).map(ref);
  const removed = base.inventory.filter((p) => !headParties.has(p.partyId)).map(ref);
  const recategorized = head.inventory
    .filter((p) => baseParties.has(p.partyId) && !same(baseParties.get(p.partyId)!.categories, p.categories))
    .map((p) => ({ ...ref(p), from: [...baseParties.get(p.partyId)!.categories] }));

  const verdicts: ConsentRunDiff['verdicts'] = [];
  for (const l of head.locations) {
    const b = base.locations.find((x) => x.id === l.id);
    if (!b) continue;
    if (b.verdict !== l.verdict) verdicts.push({ location: l.id, label: l.label, from: b.verdict, to: l.verdict });
    for (const sc of head.scenarios) {
      const from = base.grid[l.id]?.[sc]?.status;
      const to = head.grid[l.id]?.[sc]?.status;
      if (from && to && from !== to && from !== 'not-run' && to !== 'not-run') verdicts.push({ location: l.id, label: l.label, scenario: sc, from, to });
    }
  }

  const cells: ConsentRunDiff['cells'] = [];
  const classified: ConsentRunDiff['classified'] = [];
  const bm = base.behaviorMatrix;
  const hm = head.behaviorMatrix;
  if (bm && hm) {
    const baseRows = new Map(bm.rows.map((r) => [r.id, r]));
    const baseCols = new Map(bm.columns.map((c, i) => [c.id, i]));
    for (const row of hm.rows) {
      const b = baseRows.get(row.id);
      if (!b) continue;
      if (!same(b.categories, row.categories)) classified.push({ rowId: row.id, row: row.label, kind: row.kind, from: [...b.categories], to: [...row.categories], source: row.categorySource });
      hm.columns.forEach((col, i) => {
        const bi = baseCols.get(col.id);
        if (bi === undefined) return;
        const from = b.cells[bi]?.status;
        const to = row.cells[i]?.status;
        if (from && to && from !== to) cells.push({ rowId: row.id, row: row.label, kind: row.kind, columnId: col.id, column: col.label, location: col.locationLabel, from, to });
      });
    }
  }

  const bf = new Set(base.findings.map((f) => f.fingerprint));
  const hf = new Set(head.findings.map((f) => f.fingerprint));
  const persisting = [...hf].filter((f) => bf.has(f)).length;
  return {
    base: { runId: base.runId, startedAt: base.startedAt },
    head: { runId: head.runId, startedAt: head.startedAt },
    parties: { added, removed, recategorized },
    verdicts,
    cells,
    classified,
    findings: { added: hf.size - persisting, resolved: bf.size - persisting, persisting },
  };
}

export function diffIsEmpty(d: ConsentRunDiff): boolean {
  return !d.parties.added.length && !d.parties.removed.length && !d.parties.recategorized.length && !d.verdicts.length && !d.cells.length && !d.classified.length && !d.findings.added && !d.findings.resolved;
}

const STATUS: Record<string, string> = {
  match: 'working as expected', allowed: 'working as expected', mismatch: 'behavior mismatch', review: 'review needed', unknown: 'evidence missing', 'not-tested': 'not tested',
  tested: 'tested', 'not-applicable': 'no banner', verified: 'verified',
};
const st = (s: string): string => STATUS[s] ?? s;
const cats = (c: string[]): string => (c.length ? c.join(', ') : 'unclassified');

/** One-line-per-change summary lines, shared by the HTML and Markdown renderers. */
function lines(d: ConsentRunDiff): Array<{ group: string; text: string }> {
  const out: Array<{ group: string; text: string }> = [];
  for (const p of d.parties.added) out.push({ group: 'Tools that appeared', text: `${p.label} (${p.domain}) — ${cats(p.categories)}` });
  for (const p of d.parties.removed) out.push({ group: 'Tools no longer seen', text: `${p.label} (${p.domain}) — not observed in this scan; that is not proof it was removed` });
  for (const p of d.parties.recategorized) out.push({ group: 'Classification changes', text: `${p.label}: ${cats(p.from)} → ${cats(p.categories)}` });
  for (const r of d.classified.filter((r) => r.kind === 'storage')) out.push({ group: 'Classification changes', text: `${r.row}: ${cats(r.from)} → ${cats(r.to)} (${r.source})` });
  for (const v of d.verdicts) out.push({ group: 'Location and test changes', text: `${v.label}${v.scenario ? ` · ${v.scenario}` : ''}: ${st(v.from)} → ${st(v.to)}` });
  for (const c of d.cells) out.push({ group: 'Checks that changed', text: `${c.row} · ${c.column} · ${c.location}: ${st(c.from)} → ${st(c.to)}` });
  return out;
}

export interface CarriedTask {
  key: string;
  title?: string;
  at?: string;
  by?: string;
  /** The task is in this report: the scan still has something for it. */
  present: boolean;
}

function since(d: ConsentRunDiff): string {
  return d.base.startedAt.slice(0, 16).replace('T', ' ') + ' UTC';
}

/** The "Since <date>" section of the consent HTML report. */
export function renderSinceHtml(d: ConsentRunDiff | undefined, carried: CarriedTask[] = []): string {
  if (!d && !carried.length) return '';
  const body: string[] = [];
  if (d) {
    const groups = new Map<string, string[]>();
    for (const l of lines(d)) groups.set(l.group, [...(groups.get(l.group) ?? []), l.text]);
    body.push(`<p>Compared with the scan of ${esc(since(d))} (run <code>${esc(d.base.runId)}</code>): ${d.findings.added} new rule finding(s), ${d.findings.resolved} no longer observed, ${d.findings.persisting} still observed. Something not observed in this scan is not proof it was fixed.</p>`);
    body.push(groups.size ? [...groups].map(([g, items]) => `<details class="human-details"${g === 'Checks that changed' ? '' : ' open'}><summary>${esc(g)} (${items.length})</summary><div><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></details>`).join('') : '<p>No tools, classifications, locations or checks changed.</p>');
  }
  if (carried.length) {
    const still = carried.filter((t) => t.present);
    const gone = carried.filter((t) => !t.present);
    const item = (t: CarriedTask) => `<li>${esc(t.title ?? t.key)}${t.by || t.at ? ` <span class="human-muted">— marked done${t.by ? ` by ${esc(t.by)}` : ''}${t.at ? ` ${esc(t.at.slice(0, 10))}` : ''}</span>` : ''}</li>`;
    body.push(`<h3>Tasks your team marked done</h3><p>Done status comes from the site workspace and carries forward; it records your team’s work, not a verified fix.</p>${still.length ? `<p><strong>Still flagged by this scan (${still.length}) — recheck:</strong></p><ul>${still.map(item).join('')}</ul>` : ''}${gone.length ? `<p><strong>No longer in this report (${gone.length}):</strong></p><ul>${gone.map(item).join('')}</ul>` : ''}`);
  }
  return `<section id="since-last-run" class="workspace-panel"><h2 class="human-section-title">${d ? `Since ${esc(since(d))}` : 'Carried forward from your site workspace'}</h2>${body.join('')}</section>`;
}

export function renderSinceMarkdown(d: ConsentRunDiff | undefined): string {
  if (!d) return '';
  const ls = lines(d);
  const out = [`## Since ${since(d)}`, '', `${d.findings.added} new rule finding(s), ${d.findings.resolved} no longer observed, ${d.findings.persisting} still observed (vs run ${d.base.runId}).`, ''];
  if (!ls.length) out.push('No tools, classifications, locations or checks changed.', '');
  let group = '';
  for (const l of ls) {
    if (l.group !== group) {
      out.push(`**${l.group}**`, '');
      group = l.group;
    }
    out.push(`- ${l.text}`);
  }
  return out.join('\n') + '\n';
}

/** Done tasks from the workspace, matched against the task cards in a rendered report library (their data-action-key and title). */
export function carriedTasks(done: Array<{ key: string; at?: string; by?: string }> | undefined, libraryHtml: string): CarriedTask[] {
  if (!done?.length) return [];
  const titles = new Map<string, string>();
  for (const m of libraryHtml.matchAll(/data-action-key="([^"]+)"[^>]*>[\s\S]*?<h3>([\s\S]*?)<\/h3>/g)) {
    if (!titles.has(m[1])) titles.set(m[1], m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }
  return done.map((t) => ({ ...t, present: titles.has(t.key), ...(titles.has(t.key) ? { title: titles.get(t.key) } : {}) }));
}
