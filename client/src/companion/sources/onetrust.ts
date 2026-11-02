// OneTrust. Read 2026-10-14 (developer.onetrust.com; the pages are partial, see "not documented"):
//   - window.OnetrustActiveGroups: a comma-delimited string of the active group ids with a leading and
//     trailing comma (",C0001,C0002,"). Case-sensitive name. https://developer.onetrust.com/onetrust/docs/javascript-api
//     (the page only shows it tested with .includes(',C0002,'), which is what fixes the format.)
//   - OneTrustGroupsUpdated: fires on every script load and whenever the visitor changes consent;
//     event.detail is an array of the active group ids (groups with consent plus Always Active).
//     https://developer.onetrust.com/onetrust/docs/javascript-events-guide (that page's sample reads
//     event.detail while its property table says "details"; we read the global instead, so it does not matter.)
//   - OneTrust.OnConsentChanged(cb) also exists ("triggered when the user's consent status changes");
//     not used: the window event covers it and works before the OneTrust object does.
//   - OneTrust.IsAlertBoxClosed(): whether the visitor has closed the banner (answered it); when it is not a function
//     the OptanonAlertBoxClosed cookie (set when the banner is closed) stands in. Neither present = not answered.
// Not documented (so not relied on): the exact moment OnetrustActiveGroups is first populated.
// We therefore treat "the global is a string" as the banner being ready.
import { listen, win, type Read, type Source } from './types.js';

export const onetrust: Source = (push) => {
  const read = (): Read | undefined => {
    const g = win().OnetrustActiveGroups;
    if (typeof g !== 'string') return undefined;
    const ot = win().OneTrust;
    const answered = typeof ot?.IsAlertBoxClosed === 'function' ? ot.IsAlertBoxClosed() === true : /(?:^|;\s*)OptanonAlertBoxClosed=/.test(document.cookie);
    return { granted: g.split(',').filter(Boolean), answered };
  };
  listen(window, 'OneTrustGroupsUpdated', () => {
    const g = read();
    if (g) push(g);
  });
  return read;
};
