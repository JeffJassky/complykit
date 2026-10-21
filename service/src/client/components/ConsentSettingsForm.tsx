import { useId, useState } from 'react';
import type { ConsentSettings, DetectedBanner } from '../../shared/api';
import { companionNote, manualSyncCode, settingsFromDraft, type SettingsDefaults, type SettingsDraft } from '../lib/consentSettings';
import { copyText } from '../lib/useKb';

// The install task's settings form (plans/hosted-script.md "Owner settings"):
// The scan already knows the banner. With one detected: two radios ("Fully replace
// {banner} with ComplyKit" / "Add ComplyKit to {banner} for improved compliance");
// full mode shows layout, block the page and the privacy link; add-on mode follows the
// detected banner (and, when complykit can't follow it automatically, shows the line
// to add to its callback). Nothing detected: no choice, just the full-mode fields.

export interface ConsentSettingsFormViewProps {
  draft: SettingsDraft;
  defaults: SettingsDefaults;
  categoryIds: readonly string[];
  saving?: boolean;
  /** Saved just now. */
  saved?: boolean;
  error?: string;
  /** The banner the scan saw (or, for stored add-on settings with no detection, a stand-in named "your current banner"). */
  detectedBanner?: DetectedBanner;
  onChange: (patch: Partial<SettingsDraft>) => void;
  onSave: () => void;
}

export function ConsentSettingsFormView({ draft, defaults, categoryIds, saving, saved, error, detectedBanner, onChange, onSave }: ConsentSettingsFormViewProps) {
  const id = useId();
  const companion = !!detectedBanner && draft.mode === 'companion';
  const cmp = detectedBanner?.cmp ?? draft.cmp;
  const banner = detectedBanner?.label ?? 'your current banner';
  const [copied, setCopied] = useState<boolean | null>(null);
  const code = manualSyncCode(categoryIds);
  const blockPage = draft.blockPage ?? defaults.blockPage ?? false;
  return (
    <form
      className="consent-settings"
      data-testid="consent-settings"
      data-mode={companion ? 'companion' : 'full'}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <fieldset disabled={saving}>
        <legend className="section-subtitle">{detectedBanner ? 'Settings' : 'Use ComplyKit as your consent banner'}</legend>
        {detectedBanner ? (
          <>
            <label className="option">
              <input type="radio" name={`${id}-mode`} checked={!companion} onChange={() => onChange({ mode: 'full' })} data-testid="mode-full" /> <span>Fully replace {banner} with ComplyKit</span>
            </label>
            <label className="option">
              <input type="radio" name={`${id}-mode`} checked={companion} onChange={() => onChange({ mode: 'companion' })} data-testid="mode-companion" /> <span>Add ComplyKit to {banner} for improved compliance</span>
            </label>
          </>
        ) : null}

        {companion ? (
          <div data-testid="companion-fields">
            {cmp ? (
              <p className="hint" data-testid="cmp-note">
                {companionNote(cmp)}
              </p>
            ) : null}
            {cmp === 'manual' ? (
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
        <button type="submit" className="btn btn-sm btn-primary" disabled={saving || (companion && !cmp)} aria-busy={saving}>
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
export function ConsentSettingsForm({ settings, defaults, detectedBanner, categoryIds, onSave }: { settings: ConsentSettings; defaults: SettingsDefaults; detectedBanner?: DetectedBanner; categoryIds: readonly string[]; onSave: (s: ConsentSettings) => Promise<void> }) {
  // Stored add-on settings with no detection now keep both radios, naming "your current banner", so nothing changes silently.
  const banner: DetectedBanner | undefined = detectedBanner ?? (settings.mode === 'companion' && settings.cmp ? { label: 'your current banner', cmp: settings.cmp } : undefined);
  const [draft, setDraft] = useState<SettingsDraft>(() => ({ mode: banner ? settings.mode : 'full', cmp: banner?.cmp ?? settings.cmp, layout: settings.layout, blockPage: settings.blockPage, privacyPolicyUrl: settings.privacyPolicyUrl, overrides: settings.overrides }));
  const [state, setState] = useState<{ saving?: boolean; saved?: boolean; error?: string }>({});
  return (
    <ConsentSettingsFormView
      draft={draft}
      defaults={defaults}
      categoryIds={categoryIds}
      detectedBanner={banner}
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
