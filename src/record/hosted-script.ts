// The hosted consent script (plans/hosted-script.md): one file per site served by
// the complykit host at `/s/<registrable-domain>.js`. Its line 2 is exactly
//
//   window.ComplyKitConfig=<one-line JSON>;
//
// followed by the core bundle. Verify reads the config back from line 2; the
// service writes it. Both sides use these helpers so the format has one owner.

/** What line 2 of a hosted script starts with. */
export const HOSTED_CONFIG_PREFIX = 'window.ComplyKitConfig=';

/** Path of a site's hosted script on the complykit host. `domain` is the registrable domain, lower-case. */
export function hostedScriptPath(domain: string): string {
  return `/s/${domain}.js`;
}

/** The config a hosted script carries (parsed JSON), or undefined when line 2 isn't the config line or isn't JSON. */
export function parseHostedScript(text: string): unknown {
  const lines = text.split('\n');
  const line = lines[1];
  if (line === undefined || !line.startsWith(HOSTED_CONFIG_PREFIX) || !line.endsWith(';')) return undefined;
  try {
    return JSON.parse(line.slice(HOSTED_CONFIG_PREFIX.length, -1));
  } catch {
    return undefined;
  }
}
