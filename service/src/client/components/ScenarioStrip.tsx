import type { JobMetrics } from '../../shared/api';
import { SCENARIO_LABEL, formatDuration } from '../lib/format';

type Scenario = JobMetrics['scenarios'][number];
type Planned = NonNullable<JobMetrics['planned']>[number];

const STATUS_TEXT: Record<Scenario['status'], string> = {
  running: 'running',
  tested: 'tested',
  'not-tested': 'not tested',
  'not-applicable': 'not applicable',
};

/** Max upcoming chips shown; the rest are counted. */
const UPCOMING_LIMIT = 24;

/** "Reject", or "Reject · slow" for a slowed-connection repeat. */
export function scenarioName(s: { scenario: string; run?: number }): string {
  const name = SCENARIO_LABEL[s.scenario] ?? s.scenario;
  return s.run && s.run > 1 ? `${name} · slow` : name;
}

function describe(s: Scenario): string {
  let text = `${s.location} · ${SCENARIO_LABEL[s.scenario] ?? s.scenario}${s.run && s.run > 1 ? ' (slow-connection repeat)' : ''}: ${STATUS_TEXT[s.status]}`;
  if (s.reason) text += ` — ${s.reason}`;
  if (s.status === 'tested' && s.durationMs) text += ` (${formatDuration(s.durationMs)})`;
  return text;
}

const keyOf = (s: { location: string; scenario: string; run?: number }) => `${s.location}|${s.scenario}|${s.run ?? 1}`;

/** The planned visits that have not started yet, in plan order. */
export function upcomingScenarios(planned: Planned[], started: Scenario[]): Planned[] {
  const seen = new Map<string, number>();
  for (const s of started) seen.set(keyOf(s), (seen.get(keyOf(s)) ?? 0) + 1);
  return planned.filter((p) => {
    const n = seen.get(keyOf(p)) ?? 0;
    if (n > 0) {
      seen.set(keyOf(p), n - 1);
      return false;
    }
    return true;
  });
}

/** Scenarios grouped by location; each a chip coloured by status. Planned scenarios
 *  that have not started yet are listed by name at the end (`planned`); jobs from
 *  before the plan was recorded show `pending` empty slots instead. */
export function ScenarioStrip({ scenarios, planned, pending = 0 }: { scenarios: Scenario[]; planned?: Planned[]; pending?: number }) {
  const upcoming = planned ? upcomingScenarios(planned, scenarios) : undefined;
  const waiting = upcoming ? (pending > 0 ? upcoming.length : 0) : pending;
  if (scenarios.length === 0 && waiting <= 0) return null;
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const list = groups.get(s.location) ?? [];
    list.push(s);
    groups.set(s.location, list);
  }
  const multiLocation = new Set((upcoming ?? []).map((p) => p.location)).size > 1;
  return (
    <div className="scenarios">
      {[...groups].map(([location, list]) => (
        <div key={location} className="scenario-row">
          <span className="scenario-loc mono">{location}</span>
          <ul className="scenario-chips" aria-label={`Scenarios at ${location}`}>
            {list.map((s, i) => (
              <li key={`${keyOf(s)}|${i}`} className={`sc sc-${s.status}${s.run && s.run > 1 ? ' sc-repeat' : ''}`} title={describe(s)}>
                <span className="sc-dot" aria-hidden="true" />
                <span className="sc-name">{scenarioName(s)}</span>
                <span className="visually-hidden">
                  : {STATUS_TEXT[s.status]}
                  {s.reason ? ` — ${s.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {waiting > 0 && upcoming ? (
        <div className="scenario-row">
          <span className="scenario-loc">next</span>
          <ul className="scenario-chips" aria-label={`${waiting} more ${waiting === 1 ? 'scenario' : 'scenarios'} planned`}>
            {upcoming.slice(0, UPCOMING_LIMIT).map((p, i) => (
              <li key={`${keyOf(p)}|${i}`} className={`sc sc-pending sc-upcoming${p.run && p.run > 1 ? ' sc-repeat' : ''}`} title={`${p.location} · ${SCENARIO_LABEL[p.scenario] ?? p.scenario}${p.run && p.run > 1 ? ' (slow-connection repeat)' : ''}: waiting`}>
                <span className="sc-dot" aria-hidden="true" />
                <span className="sc-name">
                  {multiLocation ? `${p.location} · ` : ''}
                  {scenarioName(p)}
                </span>
              </li>
            ))}
            {upcoming.length > UPCOMING_LIMIT ? <li className="sc sc-pending sc-upcoming">+{upcoming.length - UPCOMING_LIMIT} more</li> : null}
          </ul>
        </div>
      ) : waiting > 0 ? (
        <div className="scenario-row">
          <span className="scenario-loc">next</span>
          <ul className="scenario-chips" aria-label={`${waiting} more scenarios planned`}>
            {Array.from({ length: Math.min(waiting, UPCOMING_LIMIT) }, (_, i) => (
              <li key={i} className="sc sc-pending" aria-hidden={i > 0 ? true : undefined}>
                <span className="sc-dot" aria-hidden="true" />
                {i === 0 ? <span className="visually-hidden">{waiting} waiting</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
