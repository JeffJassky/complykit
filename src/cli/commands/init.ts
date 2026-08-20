import fs from 'node:fs';
import path from 'node:path';

const CONFIG_STARTER = `// complykit configuration. Every key is absent-by-default; this starter shows
// the common shape. See https://jeffjassky.github.io/complykit/ for the full
// surface. For a one-off scan you need no config at all:
//   complykit scan --url https://example.com

/** @type {import('@jeffjassky/complykit').Config} */
export default {
  properties: [
    {
      id: 'example',
      targets: { public: { url: 'https://example.com' } },
      // tags: ['targets-eu', 'processes-personal-data'],
      routes: { sitemap: true, crawl: { maxPages: 50, sameOrigin: true } },
      rulesets: ['wcag22aa'],
    },
  ],
  budget: { failOn: 'new-critical' },
};
`;

const DISPOSITIONS_STARTER = `# complykit dispositions — tracked, human-reviewed.
# One entry per finding fingerprint you have triaged.
#
# - fingerprint: <64 hex>
#   status: open | fixed | accepted-risk | false-positive | wont-fix
#   by: your-name
#   at: 2026-08-19
#   why: short rationale
dispositions: []
`;

export function cmdInit(argv: string[]): number {
  const force = argv.includes('--force');
  const cwd = process.cwd();
  const configPath = path.join(cwd, 'complykit.config.js');
  const dispositionsPath = path.join(cwd, 'comply.dispositions.yaml');

  const wrote: string[] = [];
  for (const [file, content] of [
    [configPath, CONFIG_STARTER],
    [dispositionsPath, DISPOSITIONS_STARTER],
  ] as const) {
    if (fs.existsSync(file) && !force) {
      process.stderr.write(`exists, not overwriting (use --force): ${path.basename(file)}\n`);
      continue;
    }
    fs.writeFileSync(file, content);
    wrote.push(path.basename(file));
  }

  if (wrote.length) process.stdout.write(`wrote ${wrote.join(', ')}\n`);
  process.stdout.write('Next: complykit scan   (or: complykit scan --url https://example.com)\n');
  return 0;
}
