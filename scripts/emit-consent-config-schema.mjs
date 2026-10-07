#!/usr/bin/env node
/**
 * Write schema/consent-tool-config.schema.json from the zod schema in the built
 * bundle (dist/index.js — run `npm run build` first, like check-exports). The
 * file is what editors load through `$schema`; it is generated, never edited.
 *
 * test/consent-config.test.ts fails when the file is behind the source. The
 * same test rewrites it without a build: `UPDATE_SCHEMA=1 npx vitest run
 * test/consent-config.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bundle = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(bundle)) {
  console.error('emit-consent-config-schema: dist/index.js missing (run npm run build first).');
  process.exit(1);
}
const { consentToolConfigJsonSchema } = await import(pathToFileURL(bundle).href);
const out = path.join(root, 'schema', 'consent-tool-config.schema.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(consentToolConfigJsonSchema(), null, 2) + '\n');
console.log(`emit-consent-config-schema: wrote ${path.relative(root, out)}`);
