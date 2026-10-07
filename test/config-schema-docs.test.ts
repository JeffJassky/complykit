import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with no type declarations
import { DOCS_FILE, build } from '../scripts/render-config-schema-docs.mjs';

// G1: docs/reference/config-schema.md is rendered from the committed JSON Schema.
// `npm run docs:config-schema` rewrites it; `UPDATE_SCHEMA=1` does the same here.
describe('config schema reference page', () => {
  it('docs/reference/config-schema.md matches schema/consent-tool-config.schema.json', () => {
    const want: string = build();
    if (process.env.UPDATE_SCHEMA === '1') fs.writeFileSync(DOCS_FILE, want);
    expect(fs.existsSync(DOCS_FILE), 'run npm run docs:config-schema').toBe(true);
    expect(fs.readFileSync(DOCS_FILE, 'utf8')).toBe(want);
  });

  it('lists every top-level field of the schema', () => {
    const schema = JSON.parse(fs.readFileSync(new URL('../schema/consent-tool-config.schema.json', import.meta.url), 'utf8')) as {
      properties: Record<string, unknown>;
    };
    const page = fs.readFileSync(DOCS_FILE, 'utf8');
    for (const key of Object.keys(schema.properties)) expect(page).toContain(`| \`${key}`);
  });
});
