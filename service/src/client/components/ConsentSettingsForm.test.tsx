import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JobReportResponse, RemediationTask, SiteWorkspace } from '../../shared/api';
import { checklistFromWorkspace } from '../lib/checklist';
import { categoryIdsOf, consentSettingsOf, detectedCmpOf, manualSyncCode, settingsFromDraft } from '../lib/consentSettings';
import { ConsentSettingsForm, ConsentSettingsFormView } from './ConsentSettingsForm';
import { TodoList } from './ReportPage';
import { ChecklistPanel } from './Sites';

// The install task's settings form (plans/hosted-script.md "Owner settings").

const noop = () => {};
const view = (over: Partial<Parameters<typeof ConsentSettingsFormView>[0]> = {}) =>
  renderToStaticMarkup(<ConsentSettingsFormView draft={{ mode: 'full' }} defaults={{ layout: 'bar' }} categoryIds={['necessary', 'analytics', 'advertising']} onChange={noop} onSave={noop} {...over} />);

describe('settings form', () => {
  it('Mode comes first; full mode shows layout, block-page and the privacy link, not the banner select', () => {
    const html = view();
    expect(html).toContain('Use complykit as your consent banner');
    expect(html).toContain('Keep my banner — add complykit’s cookie cleanup');
    expect(html.indexOf('Use complykit as your consent banner')).toBeLessThan(html.indexOf('Layout'));
    expect(html).toContain('data-testid="full-fields"');
    expect(html).toContain('Default (bar)');
    expect(html).toContain('Block the page until the visitor makes a choice');
    expect(html).toContain('Privacy policy link (https)');
    expect(html).not.toContain('companion-fields');
    expect(html).toMatch(/data-testid="mode-full"[^>]*/);
  });

  it('add-on mode: the banner select lists all banners, marks the detected one, shows its note; no full-mode fields', () => {
    const html = view({ draft: { mode: 'companion', cmp: 'onetrust' }, detectedCmp: 'onetrust' });
    expect(html).toContain('data-testid="companion-fields"');
    for (const label of ['OneTrust', 'Cookiebot', 'Usercentrics', 'Didomi', 'TrustArc', 'Shopify', 'WordPress Consent API', 'IAB TCF', 'Google Consent Mode', 'Other — manual']) expect(html).toContain(label);
    expect(html).toContain('OneTrust (detected on your site)');
    expect(html).toMatch(/<option value="onetrust" selected="">/);
    expect(html).toContain('data-testid="cmp-note"');
    expect(html).not.toContain('full-fields');
    expect(html).not.toContain('manual-code');
  });

  it('manual shows the sync line with the site’s own category ids; Save is off until a banner is chosen', () => {
    const html = view({ draft: { mode: 'companion', cmp: 'manual' } });
    expect(html).toContain('data-testid="manual-code"');
    expect(html).toContain('ComplyKit.sync({ analytics: true, advertising: false })');
    expect(manualSyncCode(['necessary', 'analytics', 'advertising', 'functional'])).toBe('ComplyKit.sync({ analytics: true, advertising: false, functional: false })');
    expect(view({ draft: { mode: 'companion' } })).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(view({ draft: { mode: 'companion', cmp: 'cookiebot' } })).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('shows the save error and the saving state', () => {
    expect(view({ error: 'Could not save the settings: `privacyPolicyUrl` must be an https URL' })).toContain('privacyPolicyUrl');
    const saving = view({ saving: true });
    expect(saving).toContain('Saving…');
    expect(saving).toContain('<fieldset disabled=""');
  });

  it('the stateful form starts full by default and from the stored banner in add-on mode', () => {
    const html = renderToStaticMarkup(<ConsentSettingsForm settings={{ mode: 'full' }} defaults={{}} detectedCmp="cookiebot" categoryIds={[]} onSave={async () => {}} />);
    expect(html).toContain('data-mode="full"');
    const stored = renderToStaticMarkup(<ConsentSettingsForm settings={{ mode: 'companion', cmp: 'didomi' }} defaults={{}} detectedCmp="cookiebot" categoryIds={[]} onSave={async () => {}} />);
    expect(stored).toMatch(/<option value="didomi" selected="">/);
  });

  it('what Save sends: only the keys the owner set', () => {
    expect(settingsFromDraft({ mode: 'full' })).toEqual({ mode: 'full' });
    expect(settingsFromDraft({ mode: 'full', layout: 'modal', blockPage: false, privacyPolicyUrl: ' https://a.test/p ' })).toEqual({ mode: 'full', layout: 'modal', blockPage: false, privacyPolicyUrl: 'https://a.test/p' });
    expect(settingsFromDraft({ mode: 'full', privacyPolicyUrl: '  ' })).toEqual({ mode: 'full' });
    expect(settingsFromDraft({ mode: 'companion', cmp: 'tcf', layout: 'bar', blockPage: true })).toEqual({ mode: 'companion', cmp: 'tcf' });
  });
});

const at = '2026-10-06T10:00:00Z';
const task = (id: string, kind: string, order: number, over: Partial<RemediationTask> = {}): RemediationTask =>
  ({ id, kind, group: 'g', title: id, summary: 's', tools: [], partyIds: [], steps: ['full step'], pages: [], verify: { check: 'install', method: 'static' }, status: 'todo', optional: false, notes: [], order, ...over }) as RemediationTask;

const ws = (entries: SiteWorkspace['entries'] = {}): SiteWorkspace => ({
  version: 1,
  domain: 'example-shop.test',
  entries,
  runs: [],
  config: {
    value: {
      config: { layout: 'box', categories: [{ id: 'necessary' }, { id: 'analytics' }, { id: 'advertising' }] },
      snippet: '',
      changeList: '',
      notes: [],
      hostedScriptUrl: 'https://ck.example-host.test/s/example-shop.test.js',
      detectedCmp: 'onetrust',
      tasks: [task('install', 'install', 0, { companionSteps: ['Keep your banner.', 'Paste the line anywhere in head.'] }), task('remove-existing-tool:aaaaaaaaaaaa', 'remove-existing-tool', 1), task('rewrite-tag:bbbbbbbbbbbb', 'rewrite-tag', 2)],
    },
    at,
  },
});
const companion = ws({ 'consent-settings': { value: { mode: 'companion', cmp: 'onetrust' }, at } });

describe('the site page checklist and the settings', () => {
  it('reads the settings, the detected banner, the site’s categories and the config defaults from the workspace', () => {
    expect(consentSettingsOf(ws())).toEqual({ mode: 'full' });
    expect(consentSettingsOf(companion)).toEqual({ mode: 'companion', cmp: 'onetrust' });
    expect(consentSettingsOf(ws({ 'consent-settings': { value: { mode: 'companion', cmp: 'acme' }, at } }))).toEqual({ mode: 'full' });
    expect(detectedCmpOf(ws())).toBe('onetrust');
    expect(categoryIdsOf(ws())).toEqual(['necessary', 'analytics', 'advertising']);
  });

  it('add-on mode hides remove-existing-tool tasks and notes that blocking stays the banner’s job', () => {
    expect(checklistFromWorkspace(ws()).map((t) => t.kind)).toEqual(['install', 'remove-existing-tool', 'rewrite-tag']);
    expect(checklistFromWorkspace(companion).map((t) => t.kind)).toEqual(['install', 'rewrite-tag']);
    const html = renderToStaticMarkup(<ChecklistPanel workspace={companion} jobs={null} />);
    expect(html).toContain('data-testid="companion-note"');
    expect(html).toContain('stays the banner’s job');
    expect(html).not.toContain('remove-existing-tool');
    expect(renderToStaticMarkup(<ChecklistPanel workspace={ws()} jobs={null} />)).not.toContain('companion-note');
  });

  it('the install card carries the form (full by default), and the add-on steps when add-on', () => {
    const full = renderToStaticMarkup(<ChecklistPanel workspace={ws()} jobs={null} onSaveSettings={async () => {}} />);
    expect(full).toContain('data-testid="consent-settings"');
    expect(full).toContain('data-mode="full"');
    expect(full).not.toContain('companion-steps');
    const addon = renderToStaticMarkup(<ChecklistPanel workspace={companion} jobs={null} onSaveSettings={async () => {}} />);
    expect(addon).toContain('data-mode="companion"');
    expect(addon).toContain('data-testid="companion-steps"');
    expect(addon).toContain('Keep your banner.');
    // Add-on copy: no "first", the add-on summary, and the full-mode wording is gone.
    expect(addon).toContain('Paste in &lt;head&gt;');
    expect(addon).not.toContain('Paste first in');
    expect(addon).toContain('One line in &lt;head&gt;. Your banner keeps the choice;');
    expect(full).toContain('Paste first in &lt;head&gt;');
    expect(full).not.toContain('Your banner keeps the choice');
    // One form, on the install task only.
    expect(addon.match(/data-testid="consent-settings"/g)?.length).toBe(1);
  });
});

describe('the report page to-do list and the settings', () => {
  const data = (mode: 'full' | 'companion') =>
    ({
      job: { id: 'job1', host: 'shop.example', checks: ['consent'], status: 'done' },
      domain: 'example-shop.test',
      report: null,
      todo: { state: 'ready', tasks: [task('install', 'install', 0, { companionSteps: ['Keep your banner.'], steps: ['Paste it first in head.'] }), task('rewrite-tag:bbbbbbbbbbbb', 'rewrite-tag', 2)], fromThisRun: true },
      updating: false,
      hostedScriptUrl: 'https://ck.example-host.test/s/example-shop.test.js',
      consentSettings: { settings: mode === 'companion' ? { mode, cmp: 'cookiebot' } : { mode }, detectedCmp: 'cookiebot', categoryIds: ['necessary', 'analytics'], defaults: {} },
      history: [],
    }) as unknown as JobReportResponse;

  it('full: the full steps and the form; add-on: the add-on steps, the form on that banner, the note at the top', () => {
    const full = renderToStaticMarkup(<TodoList data={data('full')} actions={{ onSaveSettings: async () => {} }} />);
    expect(full).toContain('Paste it first in head.');
    expect(full).not.toContain('Keep your banner.');
    expect(full).toContain('data-testid="consent-settings"');
    expect(full).not.toContain('companion-note');
    const addon = renderToStaticMarkup(<TodoList data={data('companion')} actions={{ onSaveSettings: async () => {} }} />);
    expect(addon).toContain('Keep your banner.');
    expect(addon).not.toContain('Paste it first in head.');
    expect(addon).toMatch(/<option value="cookiebot" selected="">/);
    expect(addon).toContain('data-testid="companion-note"');
    expect(addon).toContain('Paste in &lt;head&gt;');
    expect(addon).not.toContain('Paste first in');
    expect(addon).toContain('One line in &lt;head&gt;. Your banner keeps the choice;');
    expect(full).toContain('Paste first in &lt;head&gt;');
    expect(full).not.toContain('Your banner keeps the choice');
    expect(addon).toMatch(/<button type="submit" class="btn btn-sm btn-primary"/);
    // Without a save handler there is no form (a read-only view).
    expect(renderToStaticMarkup(<TodoList data={data('full')} />)).not.toContain('consent-settings');
  });
});
