// Post-build step: dist/complykit-build.json = {"build":"<BUILD_ID>"}; the service reads it to know which ?v is immutable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildId } from './build-id.mjs';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'complykit-build.json'), JSON.stringify({ build: buildId() }));
