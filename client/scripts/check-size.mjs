#!/usr/bin/env node
/**
 * Fail if a gzipped IIFE exceeds its budget. Run after `npm run build`.
 *   complykit-consent.js     core, blocking in <head>   15 KB (design §6)
 *   complykit-consent-ui.js  banner + settings, async   12 KB (D9 split)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BUDGETS = { 'complykit-consent.js': 15 * 1024, 'complykit-consent-ui.js': 12 * 1024 };

let failed = false;
for (const [name, budget] of Object.entries(BUDGETS)) {
  const file = path.join(DIST, name);
  if (!fs.existsSync(file)) {
    console.error(`check-size: ${file} not found. Run \`npm run build\` first.`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(file);
  const gz = zlib.gzipSync(raw, { level: 9 }).length;
  const pct = ((gz / budget) * 100).toFixed(1);
  console.log(`check-size: ${name} ${raw.length} B raw, ${gz} B gzipped (${pct}% of ${budget} B budget)`);
  if (gz > budget) {
    console.error(`check-size: ${name} over budget by ${gz - budget} B.`);
    failed = true;
  }
}
if (failed) process.exit(1);
