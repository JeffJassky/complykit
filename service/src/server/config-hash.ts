// The consent tool config's hash, computed here exactly as the package does
// (complykit's src/record/consent-config.ts hashConsentToolConfig): sha-256 hex
// over the canonical JSON — keys sorted at every level, `undefined` values
// dropped — of the config with `hash` removed. The service never imports the
// package, so this is a copy; test/hosted-script.test.ts checks parity against
// a config the CLI stamped.

import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The hash a config should carry in its `hash` field (any existing `hash` is ignored). */
export function configHash(config: Record<string, unknown>): string {
  const { hash: _omit, ...rest } = config;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}
