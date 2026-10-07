import type { BehaviorMatrix } from '../../types/index.js';
import type { ConsentReportModel } from './consent-model.js';
import { actionControls, workspaceId } from './workspace.js';
import { escapeHtml as esc } from './human.js';
import { details, occurrences, relatedActions, type ActionGroup } from './consent-view.js';

import type { MatrixWorkspace } from './consent-matrix.js';

/** Stable task identities keep progress separate from immutable scan observations. */
export function buildMatrixWorkspace(m: ConsentReportModel, matrix: BehaviorMatrix, groups: ActionGroup[]): MatrixWorkspace {
  const tasks = new Map<string, string>();
  function task(identity: unknown, title: string, description: string, next: string, red: boolean): string {
    const id = workspaceId('behavior', identity);
    if (!tasks.has(id)) tasks.set(id, `<article id="${id}" class="human-card" data-matrix-managed data-behavior-task data-action-active="false" data-action-key="${id}" data-scan-tone="${red ? 'red' : 'amber'}" data-tone="${red ? 'red' : 'amber'}">
    <h3>${esc(title)}</h3><p>${esc(description)}</p><p><strong>What to do:</strong> ${esc(next)}</p>
    ${actionControls('tracking.behavior-review', '', true)}
    </article>`);
    return id;
  }
  const rows = matrix.rows.map(row => {
    const p = m.inventory.find(p => p.partyId === row.partyId)!;
    const index = m.inventory.indexOf(p);
    const classKey = row.kind === 'tool' ? workspaceId('tool', [p.partyId, p.domain]) : workspaceId('storage', [p.partyId, p.domain, row.storageKind, row.label]);
    const reviewId = row.kind === 'tool' ? 'tool-' + (index + 1) : classKey;
    const cells = row.cells.map((cell, i) => {
      const col = matrix.columns[i];
      const classification = cell.status === 'review' && cell.reason.startsWith('Classify the individual purpose');
      const relatedIds = relatedActions(p, groups).filter(g => {
        const contexts = occurrences(g);
        return contexts.length ? contexts.some(o => o.location === col.location && o.scenario === col.scenario) : g.findings.some(f => {
          const d = details(f);
          return (!d.location || d.location === col.location) && (!d.scenario || d.scenario === col.scenario);
        });
      }).map(g => g.id);
      const mismatchTaskId = task(['mismatch', row.id], `Fix or resolve the behavior mismatch: ${row.label}`, `This task covers all red checks in this row under your current classification.`,
        `Confirm ${row.label}’s actual purpose and required controls. If consent is required, gate its loading and storage in your consent platform or tag manager. Retest each red visitor-choice column and record the result. A purpose answer alone does not fix the site.`, true);
      const reviewTaskId = cell.comparisonFacts?.unavailable ? '' : task(['control-review', row.kind === 'tool' ? p.partyId : row.id, col.id], `Decide the controls: ${p.label} · ${col.label}`, 'Decide how this visitor action should control this tool and its storage.',
        `${col.scenario === 'gpc' ? 'Check how this tool handles the browser’s privacy opt-out signal and whether sale, sharing or targeted-advertising controls apply in this location.' : col.scenario === 'markers' ? 'Trace the sample values used in this scan through the tool’s settings and requests. Confirm what real visitor information could be sent, the recipients and purpose.' : 'Check the actual use, any restricted or denied-consent mode, and the controls required for this visitor action.'} Record sources, configuration, the reviewer’s decision and verification for ${col.locationLabel}.`, false);
      const retestTaskId = task(['retest', col.id], `Complete the check: ${col.label} · ${col.locationLabel}`, 'This column includes missing or incomplete observations. No result here can be treated as a verified pass.',
        'Read the selected cell’s reason. Make the visitor control usable, resolve location or capture limitations, and rerun this visitor action. Attach the new report or evidence. Marking this preparation done will not turn missing evidence into a passed check.', false);
      const taskId = cell.status === 'mismatch' ? mismatchTaskId : cell.status === 'review' && !classification ? reviewTaskId : ['unknown','not-tested'].includes(cell.status) ? retestTaskId : undefined;
      return { taskId, mismatchTaskId, reviewTaskId, retestTaskId, relatedIds, classification };
    });
    return {reviewId, classKey, cells};
  });
  return {rows, tasksHtml:[...tasks.values()].join('')};
}
