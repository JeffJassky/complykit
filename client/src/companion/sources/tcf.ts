// IAB TCF v2 (any CMP that exposes the standard API). Read 2026-10-14, "IAB Tech Lab - CMP API v2":
// https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md
//   - __tcfapi('addEventListener', 2, callback): callback(tcData, success) runs at once with the current
//     data and again on every change; tcData.listenerId identifies the listener.
//   - tcData.eventStatus: 'tcloaded' (a valid string is loaded), 'cmpuishown' (the UI is showing, no valid
//     consent yet), 'useractioncomplete' (the visitor just chose). Only the first and last carry a choice.
//   - tcData.purpose.consents: { "1": true, ... } by purpose id. gdprApplies false = the framework is not
//     in force (no consents are reported), so nothing is followed then.
// Purposes are reported as ids ('1'..'10'); the map turns them into categories.
import { win, type Source } from './types.js';

export const tcf: Source = (push) => {
  let attached = false;
  return () => {
    const api = win().__tcfapi;
    if (attached || typeof api !== 'function') return undefined;
    attached = true;
    api('addEventListener', 2, (d: any, ok: boolean) => {
      const c = d?.purpose?.consents;
      if (ok && c && typeof c === 'object' && (d.eventStatus === 'tcloaded' || d.eventStatus === 'useractioncomplete')) push(Object.keys(c).filter((k) => c[k] === true));
    });
    return undefined;
  };
};
