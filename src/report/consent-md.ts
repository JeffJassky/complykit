import { KIND_LABEL, SCENARIO_LABEL, type ConsentReportModel } from './consent-model.js';

// Markdown rendering of the consent evaluation — the terminal summary and a
// paste-able digest for a ticket or an agent. Same model as the HTML report.

export function renderConsentMarkdown(m: ConsentReportModel, opts: { maxFindings?: number } = {}): string {
  const lines: string[] = [];
  const t = m.totals;
  lines.push(`# Consent & tracking — ${m.site.host}`, '');
  lines.push(`Run \`${m.runId}\` · KB ${m.versions.kb} · ${t.violation} violation(s), ${t['needs-review']} need review, ${t.exposure} exposure, ${t.practice} need research.`);
  lines.push('“No finding observed” covers only what was tested; exposure items are for counsel, not violations.', '');
  lines.push('## Locations', '');
  for (const l of m.locations) {
    lines.push(`- **${l.label}** (\`${l.id}\`): ${l.verdict} — exit in ${l.observed}${l.jurisdictions.length ? `; rules for ${l.jurisdictions.join(' + ')}` : ''}${l.note ? ` (${l.note})` : ''}`);
  }
  lines.push('', '## Summary', '');
  lines.push(`| Location | ${m.scenarios.map((s) => SCENARIO_LABEL[s]).join(' | ')} |`);
  lines.push(`|---|${m.scenarios.map(() => '---').join('|')}|`);
  for (const l of m.locations) {
    const row = m.scenarios.map((s) => {
      const c = m.grid[l.id]?.[s];
      if (!c || c.status === 'not-run') return '·';
      if (c.status === 'not-tested') return 'not tested';
      if (c.status === 'not-applicable') return 'no banner';
      const parts = [c.counts.violation && `${c.counts.violation}V`, c.counts['needs-review'] && `${c.counts['needs-review']}R`, c.counts.exposure && `${c.counts.exposure}X`, c.counts.practice && `${c.counts.practice}?`].filter(Boolean);
      return parts.join(' ') || 'none observed';
    });
    lines.push(`| ${l.label} | ${row.join(' | ')} |`);
  }
  lines.push('', 'V violation · R needs review · X exposure · ? needs research', '', '## Findings', '');
  const max = opts.maxFindings ?? Infinity;
  for (const f of m.findings.slice(0, max)) {
    const d = f.details as { fix?: string; source?: string; loadedBy?: string[] };
    lines.push(`- **${KIND_LABEL[f.kind]}** · ${f.scope} · ${f.message}`);
    lines.push(`  - Rule: ${f.requirementTitle} (${f.citation})`);
    if (d.source) lines.push(`  - Came from: ${d.source}${d.loadedBy?.length ? ` — ${d.loadedBy[0]}` : ''}`);
    if (d.fix) lines.push(`  - Fix: ${d.fix}`);
  }
  if (m.findings.length > max) lines.push(`- … ${m.findings.length - max} more in the HTML report`);
  if (!m.findings.length) lines.push('No findings observed in what was tested.');
  lines.push('', `## Inventory (${m.inventory.length} outside parties)`, '');
  for (const p of m.inventory.slice(0, 40)) {
    lines.push(`- ${p.label} — ${p.recognized ? p.categories.join(', ') : 'unrecognized'}${p.behavesLikeTracker ? ' · behaves like a tracker' : ''} · ${p.hosts.slice(0, 2).join(', ')}`);
  }
  if (m.inventory.length > 40) lines.push(`- … ${m.inventory.length - 40} more`);
  if (m.researchQueue.length) {
    lines.push('', '## Research queue', '');
    for (const q of m.researchQueue) lines.push(`- ${q.domain} — ${q.reason}`);
  }
  lines.push('', '## Not tested', '');
  for (const n of m.notTested) lines.push(`- ${n.scope}${n.location ? ` · ${n.location}` : ''} · ${n.id}: ${n.reason}`);
  return lines.join('\n') + '\n';
}
