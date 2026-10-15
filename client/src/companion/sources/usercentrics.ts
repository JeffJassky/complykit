// Usercentrics (Web CMP v2 and v3). Read 2026-10-14. Parts of the vendor docs are thin; what is and is not
// confirmed:
//   Confirmed
//   - v2: UC_UI.isInitialized() (bool) and the window event UC_UI_INITIALIZED for readiness;
//     UC_UI_CMP_EVENT fires on CMP_SHOWN, ACCEPT_ALL, DENY_ALL, SAVE, ... ; the consent window event has an
//     admin-configured name (Implementation > Data Layer and Events; "ucEvent" is the docs' example);
//     the legacy dataLayer event consent_status carries ucCategory {slug: true | false | null (mixed)}.
//     https://usercentrics.com/beta-docs/web-cmp-v2-events
//   - UC_UI.getServicesBaseInfo() exists (Usercentrics Browser SDK docs, docs.usercentrics.com) and
//     categories are identified by a stable categorySlug.
//   - v3: window.__ucCmp.getConsentDetails() returns Promise<ConsentDetails>; readiness is UC_UI_INITIALIZED.
//     https://usercentrics.com/beta-docs/control-functionality
//   NOT confirmed from the docs we could read (best-effort, defensive, flagged in the ticket report)
//   - the field names on a service (consent.status) and on ConsentDetails (categories[slug].state with
//     ALL_ACCEPTED / SOME_ACCEPTED / ALL_DENIED).
// Fail closed: a category counts as granted only when ALL its services are (a mixed one is denied).
import { listen, win, type Source } from './types.js';

const yes = (v: unknown): boolean => v === true || v === 'ALL_ACCEPTED' || v === 'GRANTED';

export const usercentrics: Source = (push) => {
  const fromServices = (list: any[]): string[] => {
    const all: Record<string, boolean> = {};
    for (const s of list) {
      const slug = s?.categorySlug ?? s?.category;
      if (typeof slug === 'string') all[slug] = (all[slug] ?? true) && yes(s.consent?.status ?? s.status);
    }
    return Object.keys(all).filter((k) => all[k]);
  };
  const fromDetails = (d: any): string[] | undefined => {
    if (d?.categories && typeof d.categories === 'object') return Object.keys(d.categories).filter((k) => yes(d.categories[k]?.state ?? d.categories[k]));
    if (d?.services && typeof d.services === 'object') return fromServices(Object.values(d.services));
    return undefined;
  };
  const read = (): string[] | undefined | Promise<string[] | undefined> => {
    const w = win();
    if (w.UC_UI?.isInitialized?.() && w.UC_UI.getServicesBaseInfo) return fromServices(w.UC_UI.getServicesBaseInfo());
    if (w.__ucCmp?.getConsentDetails) return Promise.resolve(w.__ucCmp.getConsentDetails()).then(fromDetails, () => undefined);
    return undefined;
  };
  listen(window, 'UC_UI_INITIALIZED UC_UI_CMP_EVENT ucEvent UC_CONSENT', () => {
    void Promise.resolve(read()).then((g) => g && push(g));
  });
  return read;
};
