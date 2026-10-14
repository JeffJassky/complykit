import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import guideJson from '../../shared/legal-guide.json';
import type { GuideLaw, GuideLawKind, GuideModel, GuideNote, GuideNoteKind, GuidePlace, GuideRisk, GuideSource, GuideStateAct, LegalGuide } from '../../shared/legal-guide';
import { EMPTY_FILTER, filterPlaces, guidePlaceHref, isFiltered, visibleLaws, type GuideFilter } from '../lib/legalGuide';
import { Icon } from './Icon';

// The legal guide (plans/legal-guide-contract.md): how complykit tests every
// place. LegalGuideView is controlled and pure; LegalGuidePage holds the state.

const KIND_LABEL: Record<GuideLawKind, string> = { obligation: 'Duty', exposure: 'Lawsuit exposure', practice: 'Regulator practice' };
const KIND_GROUP: Array<{ kind: GuideLawKind; title: string }> = [
  { kind: 'obligation', title: 'Duties' },
  { kind: 'exposure', title: 'Lawsuit exposure' },
  { kind: 'practice', title: 'Regulator practice' },
];
const KIND_BADGE: Record<GuideLawKind, string> = { obligation: 'badge-duty', exposure: 'badge-exposure', practice: 'badge-practice' };
const RISK_LABEL: Record<GuideRisk, string> = { high: 'High risk', moderate: 'Moderate risk', 'moderate-low': 'Moderate–low risk', low: 'Low risk' };
const NOTE_LABEL: Record<GuideNoteKind, string> = { posture: 'complykit’s decision', litigation: 'In court', exception: 'Exception', pending: 'Pending' };
const SENSITIVE_LABEL: Record<GuideStateAct['sensitive'], string> = {
  'opt-in': 'Sensitive data needs opt-in consent',
  'notice-and-opt-out': 'Sensitive data: notice and a right to limit',
  'sale-banned': 'Sale of sensitive data is banned',
};
const GROUPS: Array<{ group: GuidePlace['group']; title: string }> = [
  { group: 'europe', title: 'Europe' },
  { group: 'us', title: 'United States' },
  { group: 'other', title: 'Elsewhere' },
];

const toggle = <T,>(list: readonly T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <Icon name="external" size={12} />
    </a>
  );
}

function Note({ note }: { note: GuideNote }) {
  return (
    <aside className={`guide-note note-${note.kind}`}>
      <p className="guide-note-kind">{NOTE_LABEL[note.kind]}</p>
      <p className="guide-note-title">{note.title}</p>
      <p className="guide-note-text">{note.text}</p>
      {note.sources.length ? (
        <ul className="guide-sources" aria-label="Sources">
          {note.sources.map((s: GuideSource) => (
            <li key={s.href}>
              <ExternalLink href={s.href}>{s.label}</ExternalLink>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="guide-chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

function scrollToVisits(e: MouseEvent<HTMLAnchorElement>) {
  // `#scan-visits` is not a route; scroll to it rather than navigating the hash router away.
  e.preventDefault();
  document.getElementById('scan-visits')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ModelBlock({ model }: { model: GuideModel | undefined }) {
  if (!model) return null;
  return (
    <>
      <p className="guide-prose">{model.summary}</p>
      <ul className="guide-musts" aria-label={`A site under “${model.label}” must have`}>
        {model.mustHave.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </>
  );
}

function StateAct({ act }: { act: GuideStateAct }) {
  return (
    <dl className="guide-facts">
      <div>
        <dt>State act</dt>
        <dd>
          {act.name} <span className="muted">({act.citation})</span>
          {act.urls.map((u) => (
            <span key={u}>
              {' '}
              <ExternalLink href={u}>{host(u)}</ExternalLink>
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt>{act.inForce ? 'In force since' : 'Takes effect'}</dt>
        <dd>{act.from}</dd>
      </div>
      {act.gpcFrom ? (
        <div>
          <dt>Privacy signal (GPC) honored from</dt>
          <dd>{act.gpcFrom}</dd>
        </div>
      ) : null}
      <div>
        <dt>Sensitive data</dt>
        <dd>
          {SENSITIVE_LABEL[act.sensitive]} <span className="muted">(reported, never checked by a scan)</span>
        </dd>
      </div>
    </dl>
  );
}

function PlacePanel({ guide, place }: { guide: LegalGuide; place: GuidePlace | undefined }) {
  if (!place) {
    return (
      <div className="card guide-panel guide-panel-empty" id="guide-place-panel" tabIndex={-1}>
        <h3 className="guide-panel-title">Choose a place</h3>
        <p className="muted">Pick a place from the list to see the rule model it falls under, the laws that reach it, what a scan does there, and anything particular to it.</p>
      </div>
    );
  }
  const model = guide.models.find((m) => m.id === place.model);
  const visits = place.scenarios.flatMap((id) => guide.scenarios.find((s) => s.id === id) ?? []);
  return (
    <article className="card guide-panel" id="guide-place-panel" tabIndex={-1} aria-labelledby="guide-panel-title">
      <h3 className="guide-panel-title" id="guide-panel-title">
        {place.name}
      </h3>
      <p className="guide-panel-label">{place.label}</p>
      {place.members?.length ? <p className="guide-members small muted">Covers {place.members.join(', ')}.</p> : null}
      <ModelBlock model={model} />
      {place.wiretap ? (
        <aside className="guide-note note-wiretap">
          <p className="guide-note-kind">Wiretap posture</p>
          <p className="guide-note-text">{guide.wiretap.holds}</p>
        </aside>
      ) : null}
      {place.stateAct ? <StateAct act={place.stateAct} /> : null}
      <h4 className="guide-sub">Laws that reach {place.name}</h4>
      <ul className="guide-lawlist">
        {place.lawIds.flatMap((id) => guide.laws.find((l) => l.id === id) ?? []).map((l) => (
          <li key={l.id}>
            <a href={`#law-${l.id}`} onClick={(e) => scrollToId(e, `law-${l.id}`)}>
              {l.shortName}
            </a>
          </li>
        ))}
      </ul>
      <h4 className="guide-sub">What a scan does here</h4>
      <ol className="guide-visits">
        {visits.map((v) => (
          <li key={v.id}>
            <a href="#scan-visits" onClick={scrollToVisits}>
              {v.label}
            </a>
          </li>
        ))}
      </ol>
      {place.notes.map((n) => (
        <Note key={n.title} note={n} />
      ))}
    </article>
  );
}

function scrollToId(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function PlaceRow({ place, model, chosen }: { place: GuidePlace; model: GuideModel | undefined; chosen: boolean }) {
  return (
    <li>
      <a className="guide-place" href={guidePlaceHref(place.code)} aria-current={chosen ? 'true' : undefined}>
        <span className="guide-place-name">{place.name}</span>
        <span className="guide-place-badges">
          <span className="badge badge-model">{model?.label ?? place.model}</span>
          {place.wiretap ? <span className="badge badge-wiretap">Wiretap</span> : null}
          {place.stateAct && !place.stateAct.inForce ? <span className="badge badge-pending">Act from {place.stateAct.from}</span> : null}
        </span>
      </a>
    </li>
  );
}

function LawCard({ law }: { law: GuideLaw }) {
  return (
    <article className="card guide-law" id={`law-${law.id}`} aria-labelledby={`law-${law.id}-title`}>
      <header className="guide-law-head">
        <h3 id={`law-${law.id}-title`}>{law.shortName}</h3>
        <span className={`badge ${KIND_BADGE[law.kind]}`}>{KIND_LABEL[law.kind]}</span>
        {law.risk ? <span className={`badge badge-risk badge-risk-${law.risk}`}>{RISK_LABEL[law.risk]}</span> : null}
      </header>
      <p className="guide-law-name muted">{law.name}</p>
      <p className="guide-law-scope small">
        <strong>Where:</strong> {law.scope} · Reaches {law.placeCodes.length} {law.placeCodes.length === 1 ? 'place' : 'places'}
      </p>
      <p className="guide-prose">{law.summary}</p>
      {law.notes.map((n) => (
        <Note key={n.title} note={n} />
      ))}
      <div className="guide-reqs">
        {law.requirements.map((r) => (
          <details key={r.id} className="guide-req">
            <summary>
              <span className="guide-req-title">{r.title}</span>
              <span className="guide-req-meta small muted">
                {r.citation} · since {r.since}
                {r.volatile ? <span className="badge badge-volatile">Recheck: volatile</span> : null}
              </span>
            </summary>
            <div className="guide-req-body">
              <p className="guide-req-text">{r.text}</p>
              {r.authority.length ? (
                <ul className="guide-authority" aria-label="Authority">
                  {r.authority.map((a) => (
                    <li key={a.ref}>
                      <strong>{a.ref}</strong>
                      {a.note ? ` — ${a.note}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              {r.urls.length ? (
                <ul className="guide-sources" aria-label="Sources">
                  {r.urls.map((u) => (
                    <li key={u}>
                      <ExternalLink href={u}>{host(u)}</ExternalLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </article>
  );
}

export function LegalGuideView({ guide, filter, onFilter }: { guide: LegalGuide; filter: GuideFilter; onFilter: (next: GuideFilter) => void }) {
  const places = filterPlaces(guide, filter);
  const laws = visibleLaws(guide, filter);
  const chosen = filter.place ? guide.places.find((p) => p.code === filter.place) : undefined;
  const filtered = isFiltered(filter);
  const clear = () => onFilter({ ...EMPTY_FILTER, place: filter.place });
  const modelOf = (id: string) => guide.models.find((m) => m.id === id);
  const placeName = (code: string) => guide.places.find((p) => p.code === code)?.name ?? code;

  return (
    <div className="guide">
      <header className="guide-intro">
        <p className="eyebrow">Reference</p>
        <h1>Legal guide</h1>
        <p className="guide-lede">How complykit tests every place: the rule that applies, the laws behind it, what a site must have, and which visits a scan makes.</p>
        <p className="small muted">As of {guide.asOf}</p>
      </header>

      <section className="guide-section" aria-labelledby="guide-policy">
        <h2 id="guide-policy">Policy</h2>
        <div className="card guide-policy">
          <p className="guide-policy-title">{guide.posture.title}</p>
          <ol className="guide-principles">
            {guide.posture.principles.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </div>
      </section>

      <section className="guide-section" aria-labelledby="guide-models">
        <h2 id="guide-models">Rule models</h2>
        <div className="guide-model-grid">
          {guide.models.map((m) => (
            <article key={m.id} className="card guide-model">
              <h3>{m.label}</h3>
              <ModelBlock model={m} />
            </article>
          ))}
          <article className="card guide-model guide-model-wiretap">
            <h3>Wiretap posture</h3>
            <p className="guide-prose">{guide.wiretap.summary}</p>
            <p className="guide-prose guide-holds">{guide.wiretap.holds}</p>
            <ul className="guide-states" aria-label="States in the wiretap posture">
              {guide.wiretap.states.map((code) => (
                <li key={code}>
                  <a href={guidePlaceHref(code)}>{placeName(code)}</a>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </section>

      <section className="guide-section" aria-labelledby="guide-explorer">
        <h2 id="guide-explorer">Explore by place or law</h2>

        <div className="card guide-filters">
          <div className="guide-search">
            <label htmlFor="guide-search">Find a place</label>
            <input id="guide-search" type="search" value={filter.query} placeholder="A state, a country, a rule" autoComplete="off" onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
          </div>
          <fieldset className="guide-chipset">
            <legend>Rule model</legend>
            <div className="guide-chips">
              {guide.models.map((m) => (
                <Chip key={m.id} pressed={filter.models.includes(m.id)} onClick={() => onFilter({ ...filter, models: toggle(filter.models, m.id) })}>
                  {m.label}
                </Chip>
              ))}
            </div>
          </fieldset>
          <fieldset className="guide-chipset">
            <legend>Posture</legend>
            <div className="guide-chips">
              <Chip pressed={filter.wiretap} onClick={() => onFilter({ ...filter, wiretap: !filter.wiretap })}>
                Wiretap posture
              </Chip>
            </div>
          </fieldset>
          {KIND_GROUP.map(({ kind, title }) => {
            const group = guide.laws.filter((l) => l.kind === kind);
            if (!group.length) return null;
            return (
              <fieldset key={kind} className="guide-chipset">
                <legend>{title}</legend>
                <div className="guide-chips">
                  {group.map((l) => (
                    <Chip key={l.id} pressed={filter.laws.includes(l.id)} onClick={() => onFilter({ ...filter, laws: toggle(filter.laws, l.id) })}>
                      {l.shortName}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            );
          })}
          <div className="guide-status">
            <p role="status" aria-live="polite">{`Showing ${places.length} of ${guide.places.length} places`}</p>
            {filtered ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={clear}>
                Clear filters
              </button>
            ) : null}
          </div>
        </div>

        <div className="guide-explorer">
          <nav className="guide-places" aria-label="Places">
            {places.length === 0 ? (
              <div className="empty">
                <p className="empty-title">No place matches these filters</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={clear}>
                  Clear filters
                </button>
              </div>
            ) : (
              GROUPS.map(({ group, title }) => {
                const rows = places.filter((p) => p.group === group);
                if (!rows.length) return null;
                return (
                  <div key={group} className="guide-place-group">
                    <h3>{title}</h3>
                    <ul>
                      {rows.map((p) => (
                        <PlaceRow key={p.code} place={p} model={modelOf(p.model)} chosen={p.code === filter.place} />
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
          </nav>
          <PlacePanel guide={guide} place={chosen} />
        </div>
      </section>

      <section className="guide-section" aria-labelledby="guide-laws">
        <h2 id="guide-laws">Laws{chosen ? ` that reach ${chosen.name}` : ''}</h2>
        {chosen ? (
          <p className="small muted">
            Showing only the laws that reach {chosen.name}. <a href="#laws">Show all laws</a>
          </p>
        ) : filtered ? (
          <p className="small muted">
            {filter.laws.length ? 'Showing the laws you chose.' : 'Showing the laws that reach the places listed above.'}
          </p>
        ) : null}
        <div className="guide-law-list">
          {laws.map((l) => (
            <LawCard key={l.id} law={l} />
          ))}
        </div>
      </section>

      <section className="guide-section" id="scan-visits" aria-labelledby="guide-visits">
        <h2 id="guide-visits">How we test</h2>
        <p className="guide-prose muted">A scan loads the site in a real browser several times, each visit set up differently. Which visits run depends on the place.</p>
        <ol className="guide-scenarios">
          {guide.scenarios.map((s) => (
            <li key={s.id} className="card guide-scenario">
              <h3>{s.label}</h3>
              <p className="guide-prose">
                <strong>What happens.</strong> {s.what}
              </p>
              <p className="guide-prose">
                <strong>Why.</strong> {s.why}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

const GUIDE = guideJson as unknown as LegalGuide;

export default function LegalGuidePage({ place }: { place?: string }) {
  const [state, setState] = useState<GuideFilter>(EMPTY_FILTER);
  const filter = useMemo<GuideFilter>(() => ({ ...state, place }), [state, place]);

  // Choosing a place puts its panel in front of the reader (and keeps the list where it is).
  useEffect(() => {
    if (!place) return;
    const id = requestAnimationFrame(() => {
      const el = document.getElementById('guide-place-panel');
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [place]);

  return <LegalGuideView guide={GUIDE} filter={filter} onFilter={({ place: _ignored, ...rest }) => setState(rest)} />;
}
