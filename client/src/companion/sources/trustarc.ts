// TrustArc (Cookie Consent Manager). Read 2026-10-14 (the help-center and implementation-guide pages
// are behind a login or too large to fetch; this is from the pieces we could read, so it is the least
// certain adapter):
//   - truste.cma.callApi("getConsentDecision", "<domain>") returns an integer: the highest category the
//     visitor opted into (1 = required, 2 = functional, 3 = advertising, 0 = no preference set).
//     TrustArc help center, "CCM Advanced - API Integration".
//   - PrivacyManagerAPI.callApi("getGDPRConsentDecision", "<domain>") returns { consentDecision: [1,2,3], source }
//     (the array lists the allowed categories; source "implied" = not asserted by the visitor). Seen in
//     TrustArc's GTM integration pattern (GitHub gist shadybones/71617252fd8814d1b9f9a6114030f63a).
//   - Changes: TrustArc posts window `message` events whose JSON data carries a "PrivacyManagerAPI" key;
//     the integration waits for the PrivacyManagerAPI object, then re-reads. We re-read on each such message.
// The plan's table named only truste.cma.callApi; the docs show both, so both are tried (the integer form
// first). A level n reports the ids '1'..'n' (a higher level includes the lower ones).
import { listen, win, type Source } from './types.js';

export const trustarc: Source = (push) => {
  const read = (): string[] | undefined => {
    const w = win();
    const host = location.hostname;
    let r: any;
    try {
      if (typeof w.truste?.cma?.callApi === 'function') r = w.truste.cma.callApi('getConsentDecision', host);
      else if (typeof w.PrivacyManagerAPI?.callApi === 'function') r = w.PrivacyManagerAPI.callApi('getGDPRConsentDecision', host);
    } catch {
      return undefined;
    }
    if (typeof r === 'string' && /^\d+$/.test(r)) r = Number(r);
    if (typeof r === 'number') return Array.from({ length: Math.max(0, r) }, (_, i) => String(i + 1));
    if (Array.isArray(r?.consentDecision)) return r.consentDecision.map(String);
    return undefined;
  };
  listen(window, 'message', (e) => {
    const d = (e as MessageEvent).data;
    if (typeof d === 'string' ? d.includes('PrivacyManagerAPI') : d && typeof d === 'object' && 'PrivacyManagerAPI' in d) {
      const g = read();
      if (g) push(g);
    }
  });
  return read;
};
