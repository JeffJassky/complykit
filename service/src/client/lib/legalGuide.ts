import type { GuideLaw, GuideModelId, GuidePlace, LegalGuide } from '../../shared/legal-guide';

// The legal guide page's filters (plans/legal-guide-contract.md, PR 2). Places
// and laws filter each other: choosing laws narrows the places to those the laws
// reach; choosing a place narrows the laws to that place's.

export interface GuideFilter {
  query: string;
  models: GuideModelId[];
  laws: string[];
  wiretap: boolean;
  /** The chosen place (from the route). Not a filter on the list. */
  place?: string;
}

export const EMPTY_FILTER: GuideFilter = { query: '', models: [], laws: [], wiretap: false };

export function isFiltered(f: GuideFilter): boolean {
  return f.query.trim() !== '' || f.models.length > 0 || f.laws.length > 0 || f.wiretap;
}

function matchesQuery(p: GuidePlace, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [p.name, p.code, p.code.replace(/^us-/, ''), p.label, ...(p.members ?? [])];
  return fields.some((s) => s.toLowerCase().includes(q));
}

/** Places that pass every filter group (AND across groups, OR within one), in guide order. */
export function filterPlaces(g: LegalGuide, f: GuideFilter): GuidePlace[] {
  return g.places.filter(
    (p) => (f.laws.length === 0 || p.lawIds.some((id) => f.laws.includes(id))) && (f.models.length === 0 || f.models.includes(p.model)) && (!f.wiretap || p.wiretap) && matchesQuery(p, f.query),
  );
}

/** The laws to show: the chosen place's, else the chosen laws, else those reaching a listed place, else all. */
export function visibleLaws(g: LegalGuide, f: GuideFilter): GuideLaw[] {
  const byId = new Map(g.laws.map((l) => [l.id, l]));
  const place = f.place ? g.places.find((p) => p.code === f.place) : undefined;
  if (place) return place.lawIds.flatMap((id) => byId.get(id) ?? []);
  if (f.laws.length > 0) return g.laws.filter((l) => f.laws.includes(l.id));
  if (isFiltered(f)) {
    const reached = new Set(filterPlaces(g, f).flatMap((p) => p.lawIds));
    return g.laws.filter((l) => reached.has(l.id));
  }
  return g.laws;
}

export const guidePlaceHref = (code: string) => `#laws/${code}`;
