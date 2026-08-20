# Configuration

Every key is **absent-by-default**. A static brochure site with no repo, no
auth, and no key audits with zero config file — if the zero-config path ever
pays for a generalization here, the feature is cut, not the path.

`complykit.config.js` default-exports a config (or use `defineConfig` for editor
types):

```js
import { defineConfig } from '@jeffjassky/complykit';

export default defineConfig({
  properties: [
    {
      id: 'shop',
      targets: {
        public: { url: 'https://shop.example.com' },
        // local: { command: 'npm run preview', port: 4173, readyPath: '/' },
        // staging: { url: 'https://staging.shop.example.com' },
      },
      // auth: { kind: 'storage-state', path: '.comply/auth/shop.json' },
      // repo: '.',                       // enables the static layer + manifest emit
      tags: ['targets-eu', 'processes-personal-data'],
      routes: {
        sitemap: true,
        crawl: { maxPages: 50, sameOrigin: true },
        sample: 3,                        // instances per route pattern
      },
      viewports: ['mobile', 'desktop'],
      colorSchemes: ['light', 'dark'],
      rulesets: ['wcag22aa', 'gdpr-consent'],
    },
  ],
  review: {
    models: { adjudicate: 'claude-sonnet-5', sweep: 'claude-haiku-4-5' },
    sweep: 'changed',
  },
  budget: { failOn: 'new-critical' },
});
```

## Keys

| Key | Purpose |
|---|---|
| `properties[].id` | Stable identifier; names the run's property. |
| `targets` | `public` / `local` (command + port) / `staging` URL. |
| `auth` | Playwright `storage-state` file, or a `form` login script. Absent → authed routes become a coverage gap; the run continues. |
| `repo` | Enables the static layer and route-manifest emit. |
| `tags` | Applicability tags (`targets-eu`, `processes-personal-data`, `has-ai-features`, `public-sector`), **set by hand** — nothing is auto-derived. Requirements gate on them: WCAG always applies, but a GDPR or AI Act requirement produces findings only when the property declares its tags, so an AI Act rule never fires on a brochure site. The scan *nudges* you to add `has-ai-features` when it spots AI-framework imports, but never sets it for you. |
| `routes` | `sitemap`, `crawl`, a cached `manifest` path, `include`/`exclude`, `sample`. |
| `viewports` / `colorSchemes` | The browser matrix. |
| `rulesets` | Queries over the registry (`wcag22aa`, `gdpr-consent`, `ai-act-50`), not ID lists. |
| `components` | Design-system → element map for the static layer. |
| `policies` | Privacy / terms text paths, for policy-vs-behaviour drift. |
| `review` | LLM model tiers and sweep scope. |
| `budget.failOn` | CI gate: `new-critical` (default), `new-serious`, or `none`. |

## Rulesets are queries

`wcag22aa` resolves to *instrument = wcag, level ≤ AA, version ≤ 2.2* — a saved
filter over the registry, not a hand-maintained list that drifts. See the
[Registry reference](/reference/registry).
