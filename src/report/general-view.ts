import type { Finding, Run } from '../record/index.js';
import { defectKey, aggregate, orderFindings, type DefectGroup } from './model.js';
import { explain, findingStatus, elementLabel, escapeHtml as esc, GAP_EXPLANATIONS } from './human.js';

export interface HumanDefect extends DefectGroup { members: Finding[]; }

/** HTML grouping keeps all observations, while splitting different certainty
 * classes. The JSON renderer's existing aggregate() contract is unchanged. */
export function humanDefects(findings: Finding[]): HumanDefect[] {
  const buckets = new Map<string, Finding[]>();
  for (const f of orderFindings(findings)) {
    const key = JSON.stringify([defectKey(f), findingStatus(String(f.ruleId), String(f.requirementId), f.confidence)]);
    const members = buckets.get(key) ?? [];
    members.push(f);
    buckets.set(key, members);
  }
  return [...buckets.values()].map((members) => {
    const group = aggregate(members)[0];
    // Richest evidence can belong to a less severe observation; priority still
    // uses the most severe member, never the richest representative's severity.
    return { ...group, rep: { ...group.rep, severity: members[0].severity }, members };
  }).sort((a, b) => actionRank(a) - actionRank(b));
}

function actionRank(g: HumanDefect): number {
  return ({ 'Problem observed': 0, 'Needs confirmation': 1, 'Needs investigation': 2, 'Legal review': 3 })[findingStatus(String(g.rep.ruleId), String(g.rep.requirementId), g.rep.confidence)] ?? 4;
}

export function topicId(topic: string): string {
  return `topic-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function generalCookieInventory(findings: Finding[]): string {
  const cookies = new Map<string, { name: string; domain: string; classes: Set<string>; phases: Set<string>; statuses: Set<string> }>();
  for (const f of findings) for (const e of f.evidence) {
    if (e.kind !== 'cookie') continue;
    const key = JSON.stringify([e.name, e.domain]);
    const c = cookies.get(key) ?? { name: e.name, domain: e.domain, classes: new Set<string>(), phases: new Set<string>(), statuses: new Set<string>() };
    if (e.classification) c.classes.add(e.classification);
    c.phases.add(e.phase);
    c.statuses.add(findingStatus(String(f.ruleId), String(f.requirementId), f.confidence));
    cookies.set(key, c);
  }
  if (!cookies.size) return '';
  return `<section id="cookies"><h2 class="human-section-title">Cookies needing attention</h2><p>This is a list of cookies attached to findings, not a complete cookie inventory. Classification describes the recorded purpose; it does not establish that use is appropriate.</p><div class="human-table-wrap"><table class="human-table"><thead><tr><th>Cookie</th><th>Domain</th><th>Recorded classification</th><th>What needs attention</th></tr></thead><tbody>${[...cookies.values()].map((c) => `<tr><td><code>${esc(c.name)}</code></td><td>${esc(c.domain)}</td><td>${esc([...c.classes].join(', ') || 'Needs classification')}</td><td>${esc([...c.statuses].join(', '))}<details class="human-details"><summary>Observed timing</summary><div>${esc([...c.phases].join(', '))}</div></details></td></tr>`).join('')}</tbody></table></div><p class="human-muted">Use a consent scan for the broader tool and storage inventory. This report cannot identify cookies with no findings attached.</p></section>`;
}

export function generalCoverage(run: Run): string {
  const scope = run.matrix.length ? `<ul>${run.matrix.map((c) => `<li>${c.routePatterns} page pattern(s), ${c.instances} page instance(s), ${c.states} state(s), screen sizes ${esc(c.viewports.join(', ') || 'not recorded')}, color themes ${esc(c.schemes.join(', ') || 'not recorded')}.</li>`).join('')}</ul>` : '<p>No page or screen-size matrix was recorded. Do not assume all pages were checked.</p>';
  return `<p>Checks ran with these access levels: ${esc(run.accessLevels.join(', ') || 'none recorded')}. ${run.rulesExecuted.length} executed rule(s) were recorded. This is an automated scan of the recorded scope; manual accessibility and privacy review may still be needed.</p>${scope}
  ${run.partial ? '<p class="human-callout"><strong>This was a targeted scan.</strong> It covers only the selected slice. Its totals cannot be compared directly with a full scan.</p>' : ''}
  <h3>What we could not check</h3>${run.gaps.length ? `<ul>${run.gaps.map((g) => `<li><strong>${esc(g.subject.routePattern ?? g.subject.instanceUrl ?? g.subject.property)}:</strong> ${esc(GAP_EXPLANATIONS[g.reason] ?? g.reason)}${g.note ? ` ${esc(g.note)}` : ''} <span class="human-muted">(${esc(g.reason)})</span></li>`).join('')}</ul>` : '<p>No gaps were recorded. This does not establish that the scan covered the entire site or every requirement.</p>'}`;
}

export function generalBrief(groups: HumanDefect[], run: Run): string {
  const counts = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const g of groups) {
    const f = g.rep;
    const status = findingStatus(String(f.ruleId), String(f.requirementId), f.confidence);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const topic = explain(String(f.ruleId), String(f.requirementId)).topic;
    topics.set(topic, (topics.get(topic) ?? 0) + 1);
  }
  const first = [...groups].sort((a, b) => actionRank(a) - actionRank(b)).slice(0, 3);
  return `<section id="overview"><p class="human-intro">${groups.length ? `We found ${groups.length} action item${groups.length === 1 ? '' : 's'} across ${[...topics].map(([topic, n]) => `${topic.toLowerCase()} (${n})`).join(', ')}.` : 'The checks that ran produced no findings.'} ${run.partial ? 'This was a targeted scan, so these results cover only the selected checks.' : 'Review the priorities below and check the scan coverage before drawing conclusions about the whole site.'}</p>
  <div class="human-stats">${['Problem observed', 'Needs confirmation', 'Needs investigation', 'Legal review'].map((s) => `<div class="human-stat"><strong>${counts.get(s) ?? 0}</strong><span>${s === 'Problem observed' ? 'Problems observed' : s === 'Legal review' ? 'Actions for legal review' : s}</span></div>`).join('')}</div>
  <p class="human-muted">Counts are grouped action items, not raw detections. Repeated sightings are retained in each item’s evidence.</p>
  ${run.gaps.length ? `<p class="human-callout"><strong>${run.gaps.length} scan limitation(s) need attention.</strong> <a class="human-link" href="#coverage">See what could not be checked.</a></p>` : ''}
  <h2 class="human-section-title">Start here</h2>${first.length ? `<ol class="human-next">${first.map((g) => {
    const f = g.rep; const p = explain(String(f.ruleId), String(f.requirementId));
    return `<li><a class="human-link" href="#finding-${groups.indexOf(g)}">${esc(p.title)}${elementLabel(f) ? ` — ${esc(elementLabel(f))}` : ''}</a><br><span class="human-muted">${esc(p.owner)} · ${esc(findingStatus(String(f.ruleId), String(f.requirementId), f.confidence))}</span></li>`;
  }).join('')}</ol>` : '<p>Review scan coverage and arrange any missing manual checks. No findings from an automated scan does not establish that everything is working correctly.</p>'}</section>`;
}
