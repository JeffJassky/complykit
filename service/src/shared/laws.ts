// The law catalog behind the scan form's checkboxes. Shared by server and
// client; no imports (the service never imports the complykit package). The
// `model` strings mirror describeLocationRules(...).label in the package;
// test/service-laws.test.ts fails if they drift.

export type LawId = 'eu' | 'uk' | 'ca' | 'tx' | 'us';

export interface Law {
  id: LawId;
  /** complykit location id passed to --locations. */
  locationId: 'de' | 'uk' | 'us-ca' | 'us-tx' | 'us-il';
  flyRegion: 'fra' | 'lhr' | 'lax' | 'dfw' | 'ord';
  /** Runs on the primary itself (its region is lax). */
  local?: true;
  /** Checkbox label. */
  label: string;
  /** Model line under the label, from describeLocationRules(). */
  model: string;
  /** Law names for the form. */
  laws: string;
}

export const LAWS: readonly Law[] = [
  { id: 'eu', locationId: 'de', flyRegion: 'fra', label: 'EU law', model: 'Opt-in (EU/EEA)', laws: 'GDPR, ePrivacy Directive' },
  { id: 'uk', locationId: 'uk', flyRegion: 'lhr', label: 'UK law', model: 'Opt-in (UK)', laws: 'UK GDPR, PECR' },
  {
    id: 'ca',
    locationId: 'us-ca',
    flyRegion: 'lax',
    local: true,
    label: 'California law',
    model: 'Opt-out, privacy signal honored (California)',
    laws: 'CCPA, CIPA',
  },
  {
    id: 'tx',
    locationId: 'us-tx',
    flyRegion: 'dfw',
    label: 'Texas law',
    model: 'Opt-out, privacy signal honored (Texas)',
    laws: 'Texas Data Privacy and Security Act',
  },
  {
    id: 'us',
    locationId: 'us-il',
    flyRegion: 'ord',
    label: 'US, no state privacy law',
    model: 'Opt-out (Illinois, no state privacy law in force)',
    laws: 'No comprehensive state privacy law; Illinois Eavesdropping Act (wiretap)',
  },
];

export const DEFAULT_LAWS: readonly LawId[] = LAWS.map((l) => l.id);

export function isLawId(v: unknown): v is LawId {
  return typeof v === 'string' && LAWS.some((l) => l.id === v);
}
