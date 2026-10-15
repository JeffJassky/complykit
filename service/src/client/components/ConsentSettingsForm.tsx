import { useId, useState } from 'react';
import type { CompanionCmp, ConsentSettings } from '../../shared/api';
import { companionNote, COMPANION_BANNERS, manualSyncCode, settingsFromDraft, type SettingsDefaults, type SettingsDraft } from '../lib/consentSettings';
import { copyText } from '../lib/useKb';

// The install task's settings form (plans/hosted-script.md "Owner settings"):
// Mode first; full mode: layout, block the page, privacy link; add-on mode: which
// banner to follow (preselected from the one the scan saw) and, for "other", the
// line to add to the banner's callback.

export interface ConsentSettingsFormViewProps {
  draft: SettingsDraft;
  defaults: SettingsDefaults;
  categoryIds: readonly string[];
  saving?: boolean;
  /** Saved just now. */
  saved?: boolean;
  error?: string;
  detectedCmp?: CompanionCmp;
  onChange: (patch: Partial<SettingsDraft>) => void;
  onSave: () => void;
}

export function ConsentSettingsFormView({ draft, defaults, categoryIds, saving, saved, error, detectedCmp, onChange, onSave }: ConsentSettingsFormViewProps) {
  const id = useId();
  const companion = draft.mode === 'companion';
  const [copied, setCopied] = useState<boolean | null>(null);
  const code = manualSyncCode(categoryIds);
  const blockPage = draft.blockPage ?? defaults.blockPage ?? false;
  return (
    <form
      className="consent-settings"
      data-testid="consent-settings"
      data-mode={draft.mode}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <fieldset disabled={saving}>
        <legend className="section-subtitle">Settings</legend>
        <label className="option">
          <input type="radio" name={`${id}-mode`} checked={!companion} onChange={() => onChange({ mode: 'full' })} data-testid="mode-full" /> <span>Use complykit as your consent banner</span>
        </label>
        <label className="option">
          <input type="radio" name={`${id}-mode`} checked={companion} onChange={() => onChange({ mode: 'companion' })} data-testid="mode-companion" /> <span>Keep my banner — add complykit’s cookie cleanup</span>
        </label>

        {companion ? (
          <div data-testid="companion-fields">
            <label htmlFor={`${id}-cmp`}>Your banner</label>{' '}
            <select id={`${id}-cmp`} value={draft.cmp ?? ''} onChange={(e) => onChange({ cmp: (e.target.value || undefined) as CompanionCmp | undefined })}>
              {draft.cmp ? null : <option value="">Choose your banner…</option>}
              {COMPANION_BANNERS.map((b) => (
                <option key={b.cmp} value={b.cmp}>
                  {b.label}
                  {b.cmp === detectedCmp ? ' (detected on your site)' : ''}
                </option>
              ))}
            </select>
            {draft.cmp ? (
              <p className="hint" data-testid="cmp-note">
                {companionNote(draft.cmp)}
              </p>
            ) : null}
            {draft.cmp === 'manual' ? (
              <div className="checklist-snippet" data-testid="manual-code">
                <div className="site-downloads">
                  <span>Add to your banner’s callback, with the visitor’s choices</span>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => void copyText(code).then(setCopied)}>
                    {copied === true ? 'Copied ✓' : copied === false ? 'Copy failed' : 'Copy'}
                  </button>
                </div>
                <pre>
                  <code>{code}</code>
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div data-testid="full-fields">
            <label htmlFor={`${id}-layout`}>Layout</label>{' '}
            <select id={`${id}-layout`} value={draft.layout ?? ''} onChange={(e) => onChange({ layout: (e.target.value || undefined) as SettingsDraft['layout'] })}>
              <option value="">{defaults.layout ? `Default (${defaults.layout})` : 'Default'}</option>
              <option value="bar">Bar</option>
              <option value="box">Box</option>
              <option value="modal">Modal</option>
            </select>
            <label className="option">
              <input type="checkbox" checked={blockPage} onChange={(e) => onChange({ blockPage: e.target.checked })} data-testid="block-page" /> <span>Block the page until the visitor makes a choice</span>
            </label>
            <label htmlFor={`${id}-privacy`}>Privacy policy link (https)</label>{' '}
            <input id={`${id}-privacy`} type="url" inputMode="url" placeholder={defaults.privacyPolicyUrl ?? 'https://example.com/privacy'} value={draft.privacyPolicyUrl ?? ''} onChange={(e) => onChange({ privacyPolicyUrl: e.target.value })} />
          </div>
        )}
      </fieldset>
      <p>
        <button type="submit" className="btn btn-sm btn-primary" disabled={saving || (companion && !draft.cmp)} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>{' '}
        {saved && !saving && !error ? (
          <span className="muted" role="status">
            Saved.
          </span>
        ) : null}
      </p>
      {error ? (
        <p className="banner-error" role="alert" data-testid="settings-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The form with its own draft; `onSave` rejects with the reason to show. */
export function ConsentSettingsForm({ settings, defaults, detectedCmp, categoryIds, onSave }: { settings: ConsentSettings; defaults: SettingsDefaults; detectedCmp?: CompanionCmp; categoryIds: readonly string[]; onSave: (s: ConsentSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<SettingsDraft>(() => ({ mode: settings.mode, cmp: settings.cmp ?? detectedCmp, layout: settings.layout, blockPage: settings.blockPage, privacyPolicyUrl: settings.privacyPolicyUrl }));
  const [state, setState] = useState<{ saving?: boolean; saved?: boolean; error?: string }>({});
  return (
    <ConsentSettingsFormView
      draft={draft}
      defaults={defaults}
      categoryIds={categoryIds}
      detectedCmp={detectedCmp}
      saving={state.saving}
      saved={state.saved}
      error={state.error}
      onChange={(p) => {
        setDraft((d) => ({ ...d, ...p }));
        setState({});
      }}
      onSave={async () => {
        setState({ saving: true });
        try {
          await onSave(settingsFromDraft(draft));
          setState({ saved: true });
        } catch (e) {
          setState({ error: `Could not save the settings: ${e instanceof Error ? e.message : String(e)}` });
        }
      }}
    />
  );
}
