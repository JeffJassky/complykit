import type { JobMetrics } from '../../shared/api';
import { SCENARIO_LABEL, formatDuration } from '../lib/format';

type Scenario = JobMetrics['scenarios'][number];

const STATUS_TEXT: Record<Scenario['status'], string> = {
  running: 'running',
  tested: 'tested',
  'not-tested': 'not tested',
  'not-applicable': 'not applicable',
};

function describe(s: Scenario): string {
  const name = SCENARIO_LABEL[s.scenario] ?? s.scenario;
  let text = `${s.location} · ${name}: ${STATUS_TEXT[s.status]}`;
  if (s.reason) text += ` — ${s.reason}`;
  if (s.status === 'tested' && s.durationMs) text += ` (${formatDuration(s.durationMs)})`;
  return text;
}

/** Scenarios grouped by location; each a chip coloured by status. `pending` planned
 *  scenarios that have not started yet are shown as empty slots at the end. */
export function ScenarioStrip({ scenarios, pending = 0 }: { scenarios: Scenario[]; pending?: number }) {
  if (scenarios.length === 0 && pending <= 0) return null;
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const list = groups.get(s.location) ?? [];
    list.push(s);
    groups.set(s.location, list);
  }
  return (
    <div className="scenarios">
      {[...groups].map(([location, list]) => (
        <div key={location} className="scenario-row">
          <span className="scenario-loc mono">{location}</span>
          <ul className="scenario-chips" aria-label={`Scenarios at ${location}`}>
            {list.map((s) => (
              <li key={s.scenario} className={`sc sc-${s.status}`} title={describe(s)}>
                <span className="sc-dot" aria-hidden="true" />
                <span className="sc-name">{SCENARIO_LABEL[s.scenario] ?? s.scenario}</span>
                <span className="visually-hidden">
                  : {STATUS_TEXT[s.status]}
                  {s.reason ? ` — ${s.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {pending > 0 ? (
        <div className="scenario-row">
          <span className="scenario-loc">next</span>
          <ul className="scenario-chips" aria-label={`${pending} more scenarios planned`}>
            {Array.from({ length: Math.min(pending, 24) }, (_, i) => (
              <li key={i} className="sc sc-pending" aria-hidden={i > 0 ? true : undefined}>
                <span className="sc-dot" aria-hidden="true" />
                {i === 0 ? <span className="visually-hidden">{pending} waiting</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
