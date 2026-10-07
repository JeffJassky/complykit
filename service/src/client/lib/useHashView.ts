import { useEffect, useState } from 'react';

/** The top-level views. `#kb` is the knowledge base, `#sites` and
 *  `#sites/<domain>` are the per-site pages; anything else is checks. */
export type View = 'checks' | 'kb' | 'sites';

export interface Route {
  view: View;
  /** Set on `#sites/<domain>`: the site page rather than the list. */
  domain?: string;
}

export function parseHash(hash: string): Route {
  if (hash === '#kb') return { view: 'kb' };
  if (hash === '#sites') return { view: 'sites' };
  if (hash.startsWith('#sites/')) {
    let domain = hash.slice('#sites/'.length);
    try {
      domain = decodeURIComponent(domain);
    } catch {
      /* keep it raw */
    }
    return domain ? { view: 'sites', domain } : { view: 'sites' };
  }
  return { view: 'checks' };
}

export const siteHref = (domain: string) => `#sites/${encodeURIComponent(domain)}`;

const read = (): Route => parseHash(window.location.hash);

/** Hash routing without a router: the route follows location.hash, so links,
 *  back/forward and reloads all work. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function useHashView(): View {
  return useHashRoute().view;
}
