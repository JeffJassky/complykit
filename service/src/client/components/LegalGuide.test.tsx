import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, type GuideFilter } from '../lib/legalGuide';
import { FIXTURE_GUIDE as G } from '../lib/legalGuide.fixture';
import { Header } from './Header';
import { LegalGuideView } from './LegalGuide';

// plans/legal-guide-contract.md, PR 2: the guide page. The view is controlled
// (filter in, onFilter out) so each state renders statically here.

const render = (f: Partial<GuideFilter> = {}) => renderToStaticMarkup(<LegalGuideView guide={G} filter={{ ...EMPTY_FILTER, ...f }} onFilter={() => {}} />);
const count = (html: string, s: string) => html.split(s).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ');

describe('legal guide page', () => {
  it('leads with the policy: its title and every principle', () => {
    const html = render();
    expect(html).toMatch(/<h1[^>]*>Legal guide<\/h1>/);
    expect(html).toContain(G.posture.title);
    for (const p of G.posture.principles) expect(html).toContain(p);
    expect(html).toContain('2026-10-08'); // as-of date shown
  });

  it('filters: a pressed-state chip per law and per model, a wiretap chip, and a labelled search', () => {
    const html = render({ laws: ['cipa'] });
    for (const l of G.laws) expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="(true|false)"[^>]*>[^<]*${l.shortName.replace(/[/()]/g, '.')}`));
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[^<]*CIPA/);
    for (const m of G.models) expect(html).toContain(m.label);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[^<]*Wiretap posture/);
    expect(html).toMatch(/<label[^>]*for="guide-search"[^>]*>Find a place<\/label>/);
    expect(html).toMatch(/<input[^>]*id="guide-search"/);
  });

  it('says how many places are shown, and lists only those', () => {
    const html = text(render({ laws: ['ilea'] }));
    expect(html).toContain('Showing 1 of 5 places');
    expect(html).toContain('Illinois');
    expect(html).not.toContain('Georgia');
  });

  it('each place in the list links to its own view', () => {
    const html = render();
    for (const p of G.places) expect(html).toContain(`href="#laws/${p.code}"`);
  });

  it('a chosen place shows its model, the wiretap callout, its laws with citations, its state act, its scan visits and its notes', () => {
    const html = text(render({ place: 'us-ca' }));
    expect(html).toContain('Opt-out, privacy signal honored (California)');
    expect(html).toContain('Signal summary.'); // its model, explained
    expect(html).toContain('Wiretap holds text.');
    expect(html).toContain('CCPA / CPRA');
    expect(html).toContain('CCPA / CPRA §1');
    expect(html).toContain('CIPA §1');
    expect(html).toContain('California Consumer Privacy Act');
    expect(html).toContain('Before a choice');
    expect(html).toContain('Privacy signal (GPC)');
    expect(html).toContain('Only prior consent counts'); // a note on one of its laws
    expect(html).not.toContain('ePrivacy Directive summary text.'); // laws are narrowed to the place's
  });

  it('a place note is a callout that names its kind', () => {
    const html = render({ place: 'us-il' });
    expect(html).toMatch(/class="[^"]*guide-note[^"]*note-exception[^"]*"/);
    expect(text(html)).toContain('Face scanning is a separate, stricter law');
  });

  it('every law is explained once, however many places it reaches', () => {
    const html = render();
    for (const l of G.laws) expect(count(html, l.summary)).toBe(1);
    expect(count(html, 'Opt-in summary.')).toBe(1); // models too
  });

  it('exposure laws show their litigation risk', () => {
    expect(text(render({ laws: ['cipa'] }))).toMatch(/High risk/i);
  });

  it('no matches: says so, with a way to clear the filters', () => {
    const html = text(render({ laws: ['eprivacy'], wiretap: true }));
    expect(html).toContain('No place matches these filters');
    expect(html).toContain('Clear filters');
  });
});

describe('header', () => {
  it('links to the guide, marked current on it', () => {
    const html = renderToStaticMarkup(<Header view="laws" server={null} running={0} queued={0} connection="live" />);
    expect(html).toMatch(/<a[^>]*href="#laws"[^>]*aria-current="page"[^>]*>.*Laws/);
  });
});
