import type { LoadedConfig } from '../config-load.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

// `fixtures record` drives the real collectors once and writes their artifacts
// to test/fixtures/, so rules are tested from recorded artifacts forever — no
// Chromium in the rule suite (package-structure.md). It needs the collectors,
// which land in M1 (static) and M2 (browser). Until then it is a clear stub.

export async function cmdFixturesRecord(_argv: string[], _loadConfig: LoadConfig): Promise<number> {
  process.stderr.write(
    'fixtures record needs the collectors (static: M1, browser: M2). ' +
      'Until then, add fixtures under test/fixtures/ by hand.\n',
  );
  return 2;
}
