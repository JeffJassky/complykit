import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { collectStatic } from '../../collect/static/index.js';
import type { LoadedConfig } from '../config-load.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

// `fixtures record` drives the real collectors once and writes their artifacts
// to test/fixtures/, so rules are tested from recorded artifacts forever — no
// Chromium (or a live repo) in the rule suite (package-structure.md). Browser
// fixtures arrive with M2; static works now.

export async function cmdFixturesRecord(argv: string[], _loadConfig: LoadConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      property: { type: 'string' },
      out: { type: 'string' },
      cwd: { type: 'string' },
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();
  const repoDir = path.resolve(cwd, values.repo ?? '.');
  const property = values.property ?? path.basename(repoDir);
  const out = values.out ?? path.join(cwd, 'test', 'fixtures', `${property}.static.json`);

  process.stdout.write(`recording static artifacts from ${repoDir}\n`);
  const collection = await collectStatic({ cwd: repoDir, property });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      { property, engineVersions: collection.engineVersions, hasAiFeatures: collection.hasAiFeatures, artifacts: collection.artifacts },
      null,
      2,
    ),
  );
  process.stdout.write(`wrote ${collection.artifacts.length} artifact(s) to ${out}\n`);
  return 0;
}
