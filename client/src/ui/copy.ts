// Regime-dependent pieces of the banner and settings layer (ticket F2): the
// California opt-out icon on the Privacy choices control, the privacy-policy
// link, the Global Privacy Control notice and the withdrawal note. Each returns
// '' when it does not apply (an empty text node), so banner.ts / settings.ts
// just append the result.
//
// The opt-out icon is the CPPA / California Attorney General's official design
// (CCPA Regs §7015(b); download: https://oag.ca.gov/privacy/ccpa/icons-download,
// file privacyoptions.svg, 30×14), reproduced unmodified: same viewBox, path
// data and colors (#0066FF / #FFFFFF), Illustrator group transforms dropped
// (they cancel out). The AG publishes it for businesses to use with no license
// terms beyond its usage notes: it does not replace the opt-out link text,
// online it is "approximately the same size as any other icons" on the page,
// and the recommended alt text is "California Consumer Privacy Act (CCPA)
// Opt-Out Icon" (string key optOut.iconAlt). Theming hook: `.ck-icon`.

import { h } from './dom.js';
import { host } from './host.js';
import { regime, t } from './strings.js';

const NS = 'http://www.w3.org/2000/svg';
const ICON: Array<[string, string]> = [
  ['#FFFFFF', 'M7.4,12.8h6.8l3.1-11.6H7.4C4.2,1.2,1.6,3.8,1.6,7S4.2,12.8,7.4,12.8z'],
  ['#0066FF', 'M22.6,0H7.4c-3.9,0-7,3.1-7,7s3.1,7,7,7h15.2c3.9,0,7-3.1,7-7S26.4,0,22.6,0z M1.6,7c0-3.2,2.6-5.8,5.8-5.8h9.9l-3.1,11.6H7.4C4.2,12.8,1.6,10.2,1.6,7z'],
  ['#FFFFFF', 'M24.6,4c0.2,0.2,0.2,0.6,0,0.8l0,0L22.5,7l2.2,2.2c0.2,0.2,0.2,0.6,0,0.8c-0.2,0.2-0.6,0.2-0.8,0l0,0l-2.2-2.2L19.5,10c-0.2,0.2-0.6,0.2-0.8,0c-0.2-0.2-0.2-0.6,0-0.8l0,0L20.8,7l-2.2-2.2c-0.2-0.2-0.2-0.6,0-0.8c0.2-0.2,0.6-0.2,0.8,0l0,0l2.2,2.2L23.8,4C24,3.8,24.4,3.8,24.6,4z'],
  ['#0066FF', 'M12.7,4.1c0.2,0.2,0.3,0.6,0.1,0.8l0,0L8.6,9.8C8.5,9.9,8.4,10,8.3,10c-0.2,0.1-0.5,0.1-0.7-0.1l0,0L5.4,7.7c-0.2-0.2-0.2-0.6,0-0.8c0.2-0.2,0.6-0.2,0.8,0l0,0L8,8.6l3.8-4.5C12,3.9,12.4,3.9,12.7,4.1z'],
];

function optOutIcon(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 30 14'], ['width', '30'], ['height', '14'], ['class', 'ck-icon'], ['role', 'img'], ['aria-label', t('optOut.iconAlt')]]) svg.setAttribute(k, v);
  for (const [fill, d] of ICON) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('fill-rule', 'evenodd');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Content of the persistent Privacy choices control: under opt-out-signal, the icon then "Your Privacy Choices". */
export function choicesContent(): Array<Node | string> {
  const label = t('privacyChoices.link');
  return regime() === 'opt-out-signal' ? [optOutIcon(), ' ', label] : [label];
}

/** A link to config.privacyPolicyUrl (https only, checked again: the guard is structural). */
export function policyLink(): HTMLElement | '' {
  const url = host().getConfig()?.privacyPolicyUrl;
  if (typeof url !== 'string' || !/^https:\/\/\S+$/.test(url)) return '';
  return h('p', { class: 'ck-links' }, h('a', { href: url, class: 'ck-link', 'data-ck-action': 'privacy-policy' }, t('privacyPolicy.link')));
}

/** Under an opt-out regime with GPC on: the signal was honored (CCPA Regs §7025(c)(6): display it). */
export function gpcNote(): HTMLElement | '' {
  const s = host().getStore()?.state();
  return s?.gpc && s.regime !== 'opt-in' ? h('p', { class: 'ck-note', 'data-ck-note': 'gpc' }, t('gpc.honored')) : '';
}

/** In the settings layer after a choice that granted something: how to withdraw, and what it cannot undo. */
export function withdrawNote(): HTMLElement | '' {
  const s = host().getStore()?.state();
  const granted = s?.status === 'chosen' && Object.keys(s.categories).some((id) => id !== 'necessary' && s.categories[id]);
  return granted ? h('p', { class: 'ck-note', 'data-ck-note': 'withdraw' }, `${t('withdraw.note')} ${t('withdraw.recall')}`) : '';
}
