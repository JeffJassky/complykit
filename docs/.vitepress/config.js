import { defineConfig } from 'vitepress';

// THIS FILE IS THE ONE THAT DISAPPEARS.
//
// A bare `config.js` in a global gitignore silently excluded this from
// featureboard's first push. VitePress builds fine without it, so the site
// deployed with no nav and the workflow reported success. Nothing caught it.
// `npm run check-tracked` is what catches it now — see standards/traps.md #1.

export default defineConfig({
  title: 'complykit',
  description: 'Compliance-audit toolkit: WCAG 2.2, GDPR consent + dark patterns, EU AI Act Art. 50',
  base: '/complykit/',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'complykit' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'GitHub', link: 'https://github.com/JeffJassky/complykit' },
    ],
    // Every link below must resolve — VitePress fails the build on a dead link
    // (traps #13). That is the feature.
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'The record format', link: '/guide/record-format' },
            { text: 'Coverage & honesty', link: '/guide/coverage' },
            { text: 'Adapters', link: '/guide/adapters' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Programmatic API', link: '/reference/api' },
            { text: 'Registry', link: '/reference/registry' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/JeffJassky/complykit' }],
    editLink: {
      pattern: 'https://github.com/JeffJassky/complykit/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jeff Jassky',
    },
    search: { provider: 'local' },
  },
});
