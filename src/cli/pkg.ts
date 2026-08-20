import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** This package's version, for stamping into run.json. */
export function packageVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
