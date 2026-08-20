import fs from 'node:fs';
import path from 'node:path';

// Framework detection from package.json deps — picks which ESLint parser +
// a11y plugin to apply. The host repo's own eslint config is deliberately
// ignored (their lint politics are not our audit).

export interface FrameworkInfo {
  react: boolean;
  vue: boolean;
  deps: Record<string, string>;
}

export function detectFramework(cwd: string): FrameworkInfo {
  const pkgPath = path.join(cwd, 'package.json');
  let deps: Record<string, string> = {};
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // Unreadable package.json — treat as no framework detected.
    }
  }
  return {
    react: 'react' in deps || 'next' in deps,
    vue: 'vue' in deps || 'nuxt' in deps,
    deps,
  };
}
