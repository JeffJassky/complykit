import { useEffect, useState } from 'react';

/** The top-level views. `#kb` is the knowledge base; anything else is checks. */
export type View = 'checks' | 'kb';

const read = (): View => (window.location.hash === '#kb' ? 'kb' : 'checks');

/** Hash routing without a router: the view follows location.hash, so links,
 *  back/forward and reloads all work. */
export function useHashView(): View {
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const on = () => setView(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return view;
}
