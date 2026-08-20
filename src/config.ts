import { z } from 'zod';

// The config surface (build-plan §3). Every key is absent-by-default: a static
// brochure site with no repo, no auth, no key must audit with zero config file
// (`complykit scan --url https://example.com`). If the zero-config path ever
// pays for a generalization here, cut the feature, not the path.

const UrlTarget = z.object({ url: z.string().url() });
const LocalTarget = z.object({
  command: z.string(),
  port: z.number().int(),
  readyPath: z.string().optional(),
});

export const Targets = z.object({
  public: UrlTarget.optional(),
  local: LocalTarget.optional(),
  staging: UrlTarget.optional(), // browser-design bot-defense mitigation
});
export type Targets = z.infer<typeof Targets>;

export const AuthConfig = z.union([
  z.object({ kind: z.literal('storage-state'), path: z.string() }),
  z.object({ kind: z.literal('form'), script: z.string() }),
]);
export type AuthConfig = z.infer<typeof AuthConfig>;

export const RoutesConfig = z.object({
  sitemap: z.boolean().optional(),
  crawl: z.object({ maxPages: z.number().int(), sameOrigin: z.boolean() }).optional(),
  manifest: z.string().optional(), // agent-emitted, cached, human-reviewed
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  sample: z.number().int().optional(), // instances per pattern, default applied at run
});
export type RoutesConfig = z.infer<typeof RoutesConfig>;

export const Property = z.object({
  id: z.string().min(1),
  targets: Targets,
  auth: AuthConfig.optional(),
  repo: z.string().optional(), // enables layer A + manifest emit
  tags: z.array(z.string()).optional(), // ApplicabilityTag[]; has-ai-features auto-derived
  routes: RoutesConfig.default({}),
  viewports: z.array(z.string()).optional(),
  colorSchemes: z.array(z.enum(['light', 'dark'])).optional(),
  rulesets: z.array(z.string()).default(['wcag22aa']),
  components: z.record(z.string()).optional(), // design-system -> element map
  policies: z.object({ privacy: z.string().optional(), terms: z.string().optional() }).optional(),
});
export type Property = z.infer<typeof Property>;

export const ReviewConfig = z.object({
  models: z.object({ adjudicate: z.string().optional(), sweep: z.string().optional() }).optional(),
  confirmCritical: z.boolean().optional(),
  sweep: z.enum(['all', 'changed', 'off']).optional(),
});
export type ReviewConfig = z.infer<typeof ReviewConfig>;

export const BudgetConfig = z.object({
  failOn: z.enum(['new-critical', 'new-serious', 'none']).default('new-critical'),
});
export type BudgetConfig = z.infer<typeof BudgetConfig>;

export const Config = z.object({
  properties: z.array(Property).min(1),
  review: ReviewConfig.optional(),
  budget: BudgetConfig.default({ failOn: 'new-critical' }),
});
export type Config = z.infer<typeof Config>;

/** Validate and normalize a config object. The programmatic entry point and the
 *  shape `comply.config.ts` default-exports. */
export function defineConfig(cfg: z.input<typeof Config>): Config {
  return Config.parse(cfg);
}

/**
 * The zero-config path: a single public property from just a URL. Sitemap +
 * crawl route discovery, default viewports, wcag22aa ruleset. Used by
 * `complykit scan --url` when no config file is present.
 */
export function syntheticConfig(url: string): Config {
  const host = safeHost(url);
  return defineConfig({
    properties: [
      {
        id: host,
        targets: { public: { url } },
        routes: { sitemap: true, crawl: { maxPages: 50, sameOrigin: true } },
        rulesets: ['wcag22aa'],
      },
    ],
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || 'property';
  } catch {
    return 'property';
  }
}
