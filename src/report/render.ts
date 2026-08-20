import type { Finding, Run, Severity } from '../record/index.js';
import { getRequirement, getInstrument } from '../registry/index.js';
import { renderSarif } from './sarif.js';
import { renderHtmlReport } from './html.js';

// Renderers over one run. jsonl is canonical (machine); md is the human summary.
// sarif (M1) and static-html (M5) land in their milestones. Renderer CHROME
// never says "compliant" — it states findings, evidence, and coverage. Echoed
// finding text is the producer's, not the renderer's; the vocabulary guard in
// vocabulary.ts is applied to authored chrome in tests, not to this output at
// runtime (a finding message may legitimately quote the word).

export type ReportFormat = 'jsonl' | 'md' | 'sarif' | 'html';

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

export function renderJsonl(findings: Finding[]): string {
  return findings.map((f) => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : '');
}

function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

function coverageBlock(run: Run): string {
  const lines: string[] = [];
  lines.push(`- **Property:** ${run.property}`);
  lines.push(`- **Run:** ${String(run.id)}`);
  lines.push(
    `- **Access levels exercised:** ${run.accessLevels.length ? run.accessLevels.join(', ') : 'none recorded'}`,
  );
  lines.push(
    `- **Versions:** complykit ${run.versions.package}, registry ${run.versions.registry}` +
      (Object.keys(run.versions.engines).length
        ? `, engines ${Object.entries(run.versions.engines)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')}`
        : ''),
  );
  if (run.gitSha) lines.push(`- **Commit:** ${run.gitSha}`);
  if (run.gaps.length) {
    lines.push(`- **Coverage gaps:** ${run.gaps.length}`);
    for (const g of run.gaps) {
      lines.push(`  - ${g.reason}${g.note ? ` — ${g.note}` : ''} (${g.subject.property}${g.subject.routePattern ? ` ${g.subject.routePattern}` : ''})`);
    }
  }
  return lines.join('\n');
}

function subjectLabel(f: Finding): string {
  const s = f.subject;
  if (s.routePattern) return s.routePattern;
  if (s.file) return `${s.file.path}${s.file.line ? `:${s.file.line}` : ''}`;
  return '(property-wide)';
}

export function renderMarkdown(run: Run, findings: Finding[]): string {
  const out: string[] = [];
  out.push(`# Findings — ${run.property}`);
  out.push('');
  out.push(
    'This report states **findings, evidence, and coverage**. It is not a legal ' +
      'conclusion and does not assert conformance. Each finding cites a specific ' +
      'requirement; review the evidence before acting.',
  );
  out.push('');
  out.push('## Coverage');
  out.push('');
  out.push(coverageBlock(run));
  out.push('');

  // Group by requirement, requirement groups sorted by their worst severity.
  const byReq = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = String(f.requirementId);
    const group = byReq.get(key);
    if (group) group.push(f);
    else byReq.set(key, [f]);
  }

  out.push('## Findings');
  out.push('');
  if (findings.length === 0) {
    out.push('_No findings were produced by the checks that ran. See coverage above for what was and was not exercised._');
    out.push('');
    return out.join('\n');
  }

  const groups = [...byReq.entries()].sort((a, b) => {
    const wa = Math.min(...a[1].map((f) => severityRank(f.severity)));
    const wb = Math.min(...b[1].map((f) => severityRank(f.severity)));
    return wa - wb;
  });

  for (const [reqId, group] of groups) {
    const req = getRequirement(reqId);
    const instrument = req ? getInstrument(String(req.instrument)) : undefined;
    const heading = req ? `${reqId} — ${req.title}` : reqId;
    out.push(`### ${heading}`);
    if (req) {
      out.push('');
      out.push(`> ${req.text}`);
      out.push(`> — ${instrument?.name ?? String(req.instrument)}`);
    }
    out.push('');
    for (const f of group.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))) {
      const evidence = f.evidence.length ? `${f.evidence.length} evidence item(s)` : 'no evidence attached';
      out.push(
        `- **[${f.severity}]** ${f.message}  \n` +
          `  rule \`${String(f.ruleId)}\` · confidence ${f.confidence} · ${subjectLabel(f)} · ${evidence}`,
      );
    }
    out.push('');
  }

  return out.join('\n');
}

export function renderReport(run: Run, findings: Finding[], format: ReportFormat): string {
  switch (format) {
    case 'jsonl':
      return renderJsonl(findings);
    case 'md':
      return renderMarkdown(run, findings);
    case 'sarif':
      return renderSarif(run, findings);
    case 'html':
      // The CLI report command calls renderHtmlReport directly with cwd +
      // coverage for inline evidence; this dispatch path uses defaults.
      return renderHtmlReport(run, findings);
    default: {
      const never: never = format;
      throw new Error(`unknown report format: ${String(never)}`);
    }
  }
}
