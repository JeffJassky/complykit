# Research: Existing landscape — AI-agent legal-compliance checking of web apps

Verified August 2026 by web research. Companion docs: `research-distribution.md`,
`research-compliance-sources.md`.

---

## 1. Agent skills / plugins for compliance

### 1a. Accessibility / WCAG skills

**Baseline: the official `anthropics/skills` repo contains no accessibility, GDPR,
privacy, or compliance skills** — its categories are creative/design, dev/technical,
enterprise/communication, and document skills
(https://github.com/anthropics/skills, fetched). The compliance niche is entirely
community-filled.

| Skill / plugin | URL | What it does | Approach | Maturity |
|---|---|---|---|---|
| **a11y-specialist-skills** (masuP9) | https://github.com/masuP9/a11y-specialist-skills/ | 4 skills: reviewing-a11y, auditing-wcag (WCAG 2.2 AA conformance), planning-wcag-audit, planning-a11y-improvement. Ships a separately published npm package `@a11y-skills/audit` usable in plain Playwright projects | **Rendered-browser**: axe-core + custom Playwright scripts (focus indicators, reflow, text spacing, target size) plus manual-verification phases | 55 stars, MIT, EN+JA docs. One of only two skill projects found that actually executes browser tooling |
| **accessibility-agents** (Community-Access) | https://github.com/Community-Access/accessibility-agents | 79 agents in 8 teams; 11 web-accessibility agents enforcing WCAG 2.2 AA; also document (PDF/EPUB/Office) accessibility, compliance mapping, CI/CD. Targets Claude Code, Copilot, Gemini CLI, Codex CLI, and ships an MCP server mode | **Both**: Playwright + axe-core runtime scanning AND code-review-style static instructions | 389 stars, MIT, v6.0.0, 370 commits — the most mature skill project in the niche |
| **claude-wcag-accessibility-skill** (mrKanoh) | https://github.com/mrKanoh/claude-wcag-accessibility-skill | WCAG 2.1/2.2 AA audits, WAI-ARIA patterns, screen-reader testing guidance (NVDA/JAWS/VoiceOver/TalkBack), CI/CD integration; 15 searchable databases (70+ criteria, 30+ tools) | Knowledge-base skill (databases + instructions); no evidence of executing browsers itself | Details beyond search listing UNVERIFIED |
| **accessibility-audit-toolkit** (tendera01-spec) | https://github.com/tendera01-spec/accessibility-audit-toolkit | WCAG 2.2 AA audits, German BFSG / EU EAA conformance, VPAT 2.5 / ACR generation, for Claude Code + Cowork | **Explicitly not automated** — interprets outputs of axe-core/Pa11y, does not run them | v0.1.0, 0 stars, 3 commits, MIT + CC BY 4.0. Very early |
| **a11y-audit** (alirezarezvani/claude-skills) | https://alirezarezvani.github.io/claude-skills/skills/engineering-team/a11y-audit/ | Three-phase Scan → Fix → Verify workflow; WCAG 2.2 A/AA violations, per-framework fix code, stakeholder reports | Per listing, workflow instructions; execution mechanics UNVERIFIED | Part of a large multi-skill marketplace repo |
| **accessibility-audit** (rampstackco/claude-skills) | https://github.com/rampstackco/claude-skills/blob/main/skills/accessibility-audit/SKILL.md | SKILL.md-format accessibility audit skill | UNVERIFIED (found via search, not fetched) | UNVERIFIED |
| **wcag-audit-claude-skill** (CFLW-AI) | https://github.com/CFLW-AI/wcag-audit-claude-skill | WCAG audit skill | UNVERIFIED | UNVERIFIED |
| **a-and-t-claude-skills** (automateandtweak) | https://github.com/automateandtweak/a-and-t-claude-skills | Web-dev skills incl. WCAG audits | UNVERIFIED | UNVERIFIED |
| **accessibility-skills** (mgifford, CivicActions) | https://github.com/mgifford/accessibility-skills | Claude skills mirroring the author's ACCESSIBILITY.md guidance | Knowledge/instructions | Notable because Mike Gifford is a known open-source a11y figure; details UNVERIFIED |
| **designer-skills / inclusive-design-skills** (Owl-Listener, Matthew Stephens) | https://github.com/Owl-Listener/designer-skills, https://github.com/Owl-Listener/inclusive-design-skills | 241 skills/91 commands across 33 plugins for Claude Code + Gemini CLI; companion repo has 40 inclusive-design skills (cognitive accessibility, adaptive interfaces, accessibility decision-making). Backstory: https://matthewlarn.medium.com/i-built-33-claude-skills-to-fix-the-vibe-design-accessibility-gap-a0f7f3ff1d1c | Design-guidance skills (prevention at generation time), not audit tooling | Actively promoted mid-2026 |
| **accessibility-compliance** (wshobson/agents) | https://skills.sh/wshobson/agents/accessibility-compliance | "Accessibility expert" persona skill: WCAG 2.2 AA / ADA / Section 508 audit + remediation guidance | Pure prompt/knowledge skill | Listed on skills.sh; mirrored on agentskills.me and claudeskills.info |
| **Addy Osmani accessibility skill** | https://officialskills.sh/addyosmani/skills/accessibility | Accessibility skill in Osmani's collection | UNVERIFIED | UNVERIFIED |
| **claude-marketplace** (deepakkamboj) | https://github.com/deepakkamboj/claude-marketplace | Claude Code plugin marketplace: WCAG 2.1 accessibility, Playwright testing, "runtime scanning" | Claims Playwright-based runtime scanning; UNVERIFIED | UNVERIFIED |

Registry directories that index these: skills.sh, agentskills.me, claudeskills.info,
officialskills.sh, mcpmarket.com
(https://mcpmarket.com/tools/skills/wcag-accessibility-compliance), claudedirectory.org
accessibility topic (https://www.claudedirectory.org/plugins/topic/accessibility), and
awesome-claude-plugins (https://github.com/Chat2AnyLLM/awesome-claude-plugins).

### 1b. GDPR / privacy skills

| Skill / plugin | URL | What it does | Approach |
|---|---|---|---|
| **Privacy-Data-Protection-Skills** (mukul975) | https://github.com/mukul975/Privacy-Data-Protection-Skills | 282+ skills: GDPR (50+), CCPA/CPRA (13+), **EU AI Act (15+)**, HIPAA, LGPD, PIPL, DPDP, SCCs/BCRs. agentskills.io SKILL.md format with references/, assets/, and **Python-stdlib automation scripts** | Knowledge + light script automation for privacy *workflows* (DSARs, DPIAs) — **not** website scanning. 218 stars, Apache-2.0, active (fetched) |
| **gdpr-compliant** (github/awesome-copilot) | https://github.com/github/awesome-copilot/blob/main/skills/gdpr-compliant/SKILL.md | GitHub's official Copilot skill: privacy-by-design guidance for APIs, data models, auth, cookies, breach response; based on CNIL guidance + GDPR Arts. 5/25/32/33/35 | Code-authoring guidance, not auditing |
| **compliance-os / gdpr-dsgvo-expert** (alirezarezvani/claude-skills) | https://github.com/alirezarezvani/claude-skills/blob/main/compliance-os/agents/cs-dpo-gdpr.md, https://github.com/alirezarezvani/claude-skills/blob/main/ra-qm-team/skills/gdpr-dsgvo-expert/SKILL.md | DPO agent + skill that scans codebases for privacy risks, generates DPIA docs, tracks DSARs | Static codebase analysis + document generation |
| **skill-audit** (dabit3) | https://github.com/dabit3/skill-audit | Adjacent: audits *skill definitions themselves* for security/completeness across Codex, Claude Code, etc. | CLI static analysis |

### 1c. Key takeaway

The skill ecosystem is crowded with **knowledge-only prompt packs** (WCAG criterion
databases, GDPR article summaries, report templates). Only **two** projects (masuP9,
Community-Access) actually drive a real browser against rendered pages, and both are
accessibility-only. **No agent skill was found that performs rendered-site GDPR
evidence collection, privacy-policy drift detection, or EU AI Act on-page disclosure
verification.**

---

## 2. MCP servers for accessibility / compliance

| MCP server | URL | Engine / approach | Rendered page? | Notes |
|---|---|---|---|---|
| **axe-mcp-server-public** (Deque, official) | https://github.com/dequelabs/axe-mcp-server-public | axe; `analyze` + `remediate` tools; Docker | Yes (axe DevTools scanning) | **Proprietary; requires paid axe DevTools subscription + API key.** 6 stars, 11 commits (fetched) |
| **a11y-mcp** (priyankark) | https://github.com/priyankark/a11y-mcp | axe-core; `audit_webpage`, `get_summary`, WCAG-tag filtering | Yes | MPL-2.0, 48 stars, 17 commits (fetched) |
| **a11ymcp** (ronantakizawa) | https://github.com/ronantakizawa/a11ymcp | axe-core + Puppeteer | Yes | 6k+ downloads, #20 ProductHunt (per repo description) |
| **a11y-mcp** (CalvHobbes) | https://github.com/CalvHobbes/a11y-mcp | Playwright + axe-core | Yes | UNVERIFIED beyond listing |
| **cursor-a11y-mcp** (westsideori) | https://github.com/westsideori/cursor-a11y-mcp | axe-core + Puppeteer, built for Cursor | Yes | UNVERIFIED beyond listing |
| **mcp-web-a11y** (bilhasry-deriv) | https://mcpservers.org/servers/bilhasry-deriv/mcp-web-a11y | WCAG checks | UNVERIFIED | Listing only |
| **mcp-axe** (manoj9788) | https://lobehub.com/mcp/manoj9788-mcp-axe | axe wrapper | UNVERIFIED | Listing only |
| **lighthouse-mcp-server** (danielsogl) | https://github.com/danielsogl/lighthouse-mcp-server | Google Lighthouse; 13+ tools: performance, accessibility, SEO, security, Core Web Vitals | Yes (headless Chrome) | Listed in official MCP Registry |
| **lighthouse-mcp** (npm) | https://www.npmjs.com/package/lighthouse-mcp | Lighthouse wrapper | Yes | Needs Node 16+ and local Chrome |
| **mcp-lighthouse-audit** (jladev) | https://lobehub.com/mcp/jladev-mcp-lighthouse-audit | Lighthouse audits with failing elements + suggestions | Yes | Listing only |
| **chrome-devtools-mcp** (Google, official) | https://github.com/ChromeDevTools/chrome-devtools-mcp | Full CDP control: performance traces, network, console, screenshots, accessibility tree | Yes — live Chrome | General-purpose debugging, not a compliance auditor; agents can run audits through it |
| **playwright-mcp** (Microsoft) | https://github.com/microsoft/playwright-mcp | Browser automation via **accessibility-tree snapshots** (~200–400 tokens/snapshot, refs per element) | Yes | Automation substrate, not a WCAG checker. Known caveats: snapshot includes off-screen elements (https://github.com/microsoft/playwright/issues/39955), serializes password values in plaintext (https://github.com/microsoft/playwright-mcp/issues/1566) |
| **Apify actor MCPs** | https://apify.com/openfrontier_ai/web-accessibility-wcag-auditor/api/mcp ($0.25/run), https://apify.com/katzino/actor-web-a11y-audit/api/mcp, https://apify.com/second_coming/wcag-scanner/api/mcp | Hosted WCAG scanner actors exposed as MCP | Yes (hosted) | Paid/metered cloud, not self-hosted open source |
| **open-legal-compliance-mcp** (TCoder920x) | https://github.com/TCoder920x/open-legal-compliance-mcp | Legal compliance analysis via free government APIs | No (API lookups) | Not a site scanner |
| **mcp-eu-ai-act** (ark-forge) | https://github.com/ark-forge/mcp-eu-ai-act | **Static codebase scan**: detects 16 AI frameworks, maps to EU AI Act articles, transparency/risk checks, Annex IV packages | **No — source code only, never the live site** | 11 stars, MIT, freemium (€29/mo Pro), fetched |

**Notably absent**: no MCP server was found that performs GDPR website scanning
(cookies/trackers/consent behavior), privacy-policy analysis, or rendered-page EU AI
Act disclosure checking. The accessibility MCP space, by contrast, is saturated with
thin axe-core wrappers.

---

## 3. Underlying non-AI tooling

### 3a. Accessibility engines

| Tool | URL | Checks | License | Headless | Rendered full-page context? |
|---|---|---|---|---|---|
| **axe-core** (Deque) | https://github.com/dequelabs/axe-core | WCAG 2.0/2.1/2.2 A/AA/AAA + best practices; finds ~57% of WCAG issues automatically; flags "incomplete" for manual review | MPL-2.0 | Yes (via any driver) | **Yes — injected JS running in the live page DOM with all CSS/JS applied.** Satisfies the full-page-context constraint. 7.4k stars, actively maintained (fetched) |
| **Lighthouse** (Google) | https://github.com/GoogleChrome/lighthouse | Performance, accessibility (a11y category powered by axe-core, weighted by user impact — https://developer.chrome.com/docs/lighthouse/accessibility/scoring), SEO, best practices | Apache-2.0 | Yes (headless Chrome) | **Yes** |
| **pa11y / pa11y-ci** | https://github.com/pa11y/pa11y, https://github.com/pa11y/pa11y-ci | Wraps HTML_CodeSniffer (https://github.com/pa11y/pa11y-runner-htmlcs) and axe runners; CLI + JS API; structured issues with selectors/severity | LGPL-3.0 | Yes (Headless Chrome since v5) | **Yes** |
| **IBM Equal Access** | https://github.com/IBMa/equal-access | WCAG 2.0/2.1/2.2 + US Section 508 via IBM ruleset; engine + `accessibility-checker` Node module + browser extensions + Cypress/Karma wrappers | Apache-2.0 | Yes | **Yes — designed to run with Selenium/Puppeteer/Playwright against live pages** (fetched) |
| **WAVE stand-alone API** (WebAIM) | https://wave.webaim.org/standalone, https://wave.webaim.org/api/ | WAVE ruleset; "full DOM analysis of a rendered web page" in self-contained headless Chrome after scripting has been applied | **Commercial, not open source** | Yes | **Yes** |
| **QualWeb** | https://github.com/qualweb, https://github.com/qualweb/act-rules | W3C ACT Rules + WCAG 2.1 techniques; `@qualweb/core`, `@qualweb/cli` npm packages; Chrome extension | Open source (exact license UNVERIFIED) | Yes | Browser-based evaluation of loaded pages (exact rendering pipeline UNVERIFIED) |
| **Playwright ARIA snapshots** | https://playwright.dev/docs/aria-snapshots | YAML accessibility-tree of the rendered page; `page.ariaSnapshot()`, `toMatchAriaSnapshot()` with partial matching | Apache-2.0 | Yes | **Yes** — but it's a *structural regression* tool, not a WCAG rules engine |
| **unlighthouse** (harlan-zw) | https://github.com/harlan-zw/unlighthouse | **Site-wide** Lighthouse: URL discovery via robots.txt/sitemap/links, parallel Chrome instances, budgets, CI binary | Open source (free) | Yes | **Yes** (Lighthouse under the hood) |
| **A11yWatch / kayle** | https://github.com/a11ywatch/a11ywatch, https://github.com/a11ywatch/kayle | Site-wide accessibility automation; kayle = concurrent crawler feeding audit engines | Open-source "Lite" of a paid SaaS | Yes | Yes (crawler + audit service) |
| **rangle/a11y-violations-crawler** | https://github.com/rangle/a11y-violations-crawler | Crawls a site, runs each page through axe-core | UNVERIFIED | Yes | Yes |

**Tools that do NOT satisfy full-page context** (for the record): jest-axe /
Storybook-style isolated component renders and any static-markup linters
(eslint-plugin-jsx-a11y etc.) evaluate markup without the site's global CSS/JS — none
of these appear above; all engines listed run against complete loaded pages.

### 3b. GDPR / tracking scanners

| Tool | URL | Checks | License | Headless / rendered |
|---|---|---|---|---|
| **EDPS Website Evidence Collector (WEC)** | https://github.com/EU-EDPS/website-evidence-collector (now primary at https://code.europa.eu/EDPS/website-evidence-collector) | Automates evidence collection of personal-data storage/transfer: cookies, localStorage, third-party requests, beacons; built by the EU's own data-protection supervisor for inspections | **EUPL** | Yes — Node.js + Chromium (Puppeteer). **Rendered full-page** |
| **Blacklight** (The Markup) | https://themarkup.org/blacklight/2020/09/22/how-we-built-a-real-time-privacy-inspector, batch CLI: https://themarkup.org/blacklight/2024/10/16/blacklight-query | Third-party cookies, ad trackers, key-logging, session recording, canvas fingerprinting, FB pixel, GA; tracker DB updated Feb 2026 (TikTok/X) | Open source, **custom license**, NPM module | Yes — Node.js + Puppeteer. **Rendered full-page** |
| **CookieBlock-Consent-Crawler + Violation-Detection** (ETH Zürich) | https://github.com/dibollinger/CookieBlock-Consent-Crawler, https://github.com/dibollinger/CookieBlock-Violation-Detection | Crawls sites, extracts cookies + declared purposes from CMPs (Cookiebot/OneTrust etc.), then detects GDPR violations (undeclared cookies, wrong purposes, consent ignored) | Open source (research code) | Yes — OpenWPM (Firefox-based). Rendered. Research-grade, maintenance UNVERIFIED |
| **CookieScanner** (CovenantSQL) | https://github.com/CovenantSQL/CookieScanner | Cookie status analysis + GDPR report generation | Open source | UNVERIFIED; likely stale |
| **gdpr-analyzer** (dev4privacy) | https://github.com/dev4privacy/gdpr-analyzer | Scores webpage GDPR compliance from source code + behavior | Free/open source | Maturity UNVERIFIED |
| **gdpr.observer** (Hermes Center) | https://github.com/hermescenter/gdpr.observer | GDPR observation at scale | UNVERIFIED | UNVERIFIED |

### 3c. Privacy-policy / ToS analyzers and drift detection

| Tool | URL | What it does |
|---|---|---|
| **Open Terms Archive engine** | https://github.com/OpenTermsArchive (docs https://docs.opentermsarchive.org/) | The reference implementation for ToS/privacy-policy **drift**: Node.js engine that downloads, archives, and publishes versioned terms; near-real-time change alerts; public datasets (e.g., Platform Governance Archive https://github.com/OpenTermsArchive/pga-versions). French NGO, active |
| **TOSTracker** | https://tostracker.app/ | Hosted: 80,000+ legal documents tracked with side-by-side diffs, clause analysis, permanent citable URLs. Not open source (UNVERIFIED) |
| **changedetection.io** | https://github.com/dgtlmoon/changedetection.io | Generic self-hosted page-change monitoring; commonly used for ToS/policy watch; timestamped change archive |
| **Polisis / PriBot** | https://github.com/quanmou/polisis | Deep-learning privacy-policy segmentation/labeling + QA chatbot. Academic, effectively dormant (mirror repo) |
| **ToS;DR** | tosdr.org | Crowdsourced ToS summaries/ratings; free and open source. UNVERIFIED beyond listing |
| **TOS-privacy-risk-analysis-tool** (RZhu04) | https://github.com/RZhu04/TOS-privacy-risk-analysis-tool | BERT-based ToS risk flagging; student project |
| **ai-privacy-policy-analyzer** (zahidaz) | https://github.com/zahidaz/ai-privacy-policy-analyzer | Chrome extension; GPT-3.5 / local-model policy summaries |

### 3d. EU AI Act tooling (all static / questionnaire — none check the rendered site)

| Tool | URL | Approach |
|---|---|---|
| **Systima Comply** | https://systima.ai/blog/systima-comply-eu-ai-act-compliance-scanning (npm CLI + GitHub Action) | Detects 37+ AI frameworks in code, validates risk class, checks Articles 5–50, detects disclosure patterns **in UI source code** — static only |
| **AIR Blackbox** | https://airblackbox.ai/blog/eu-ai-act-compliance-tools-compared | Local (Ollama) scanner, 6 checks mapped to articles — static |
| **mcp-eu-ai-act** (ark-forge) | https://github.com/ark-forge/mcp-eu-ai-act | Static codebase scan (see §2) |
| **VerifyWise** | https://verifywise.ai/user-guide/ai-detection/scanning | Repo scanning → EU AI Act checklist |
| **AI Act Compliance Checker** | https://artificialintelligenceact.eu/transparency-rules-article-50/ | Interactive questionnaire, no scanning |

Context: Article 50 transparency obligations (disclose chatbots, mark
AI-generated/deepfake content machine-readably) **apply from August 2, 2026** — i.e.,
this month (https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act).

---

## 4. Commercial products (brief)

- **accessiBe** — overlay widget; hit with a finalized **$1M FTC order (2025)** for
  deceptive "AI makes you WCAG-compliant" claims
  (https://adrianroselli.com/2025/01/ftc-catches-up-to-accessibe.html).
- **AudioEye / UserWay / EqualWeb** — competing overlays + audit services; the
  LightHouse v. ADP settlement explicitly deemed overlays insufficient; ~500 lawsuits
  targeted overlay-equipped sites in H1 2025; Overlay Fact Sheet signed by 800+
  professionals.
- **Deque (axe DevTools/Monitor)** — enterprise tier atop axe-core; official MCP
  requires paid subscription.
- **WebAIM WAVE API** — paid rendered-page analysis API (https://wave.webaim.org/api/).
- **TestParty** — AI-powered accessibility remediation startup.
- **Level Access, Siteimprove, Silktide, Evinced** — enterprise a11y monitoring
  platforms. UNVERIFIED individually.
- **Osano** — CMP + data-privacy platform; free URL scan for GPC/dark patterns.
- **OneTrust** — broad enterprise privacy/GRC suite incl. consent + cookie scanning.
- **Cookiebot (Usercentrics)** — automated cookie scanning + consent collection.
- **Termly** — SMB policy generators + consent banner.
- **iubenda** — auto-updating legal document generators.
- **Vanta** — GRC platform that already ships a Claude Code plugin/MCP for fixing
  compliance failures with repo context (https://www.aitmpl.com/plugins/).

---

## 5. Gap analysis — where an open agent-skill suite adds unique value

**What's saturated (don't rebuild):**

- Thin axe-core MCP wrappers for single-URL scans (≥6 exist, §2).
- WCAG knowledge-base prompt packs (≥10 exist, §1a).
- GDPR/DPIA document-generation skills (mukul975 alone has 282, §1b).

**Verified gaps:**

1. **No skill/MCP wires GDPR website evidence collection to an agent.** WEC (EUPL) and
   Blacklight (Puppeteer) are mature, headless, rendered-page scanners built by a
   regulator and a newsroom respectively — and nothing in the skill/MCP ecosystem
   wraps either. An agent that runs WEC/Blacklight-class collection and then
   *interprets* the evidence against GDPR/ePrivacy rules would be first of its kind.
2. **No rendered-page EU AI Act Article 50 checker exists anywhere** — commercial or
   open. Every existing tool (Systima, AIR Blackbox, ark-forge MCP, VerifyWise) scans
   source code or asks questionnaires; none loads the live site to verify a chatbot
   actually discloses itself or AI content carries the required marking. With Art. 50
   enforceable as of Aug 2, 2026, this is the largest greenfield.
3. **No policy-vs-behavior drift detection.** Open Terms Archive diffs policy *text*
   over time; WEC/Blacklight capture *behavior*. Nothing cross-references them
   ("policy claims no third-party analytics; scan found Meta Pixel firing
   pre-consent"). That reconciliation is exactly LLM-shaped work no deterministic tool
   does.
4. **Consent-flow behavioral testing is research-code only.** CookieBlock's violation
   detection (reject-all parity, cookies set before consent, undeclared purposes)
   never left academia; commercial CMP scanners (Cookiebot, Osano) only check their
   own banners. An agent that drives the banner (accept/reject paths) in a real
   browser and diffs the resulting cookie/network state is unclaimed territory.
5. **Full-page-context judgment checks.** Automated engines catch ~57% of WCAG issues
   (axe-core's own figure); the remainder (alt-text *quality*, sensible focus order,
   dark patterns in consent UI) needs LLM judgment grounded in rendered screenshots +
   DOM. Only masuP9 and Community-Access gesture at this, a11y-only.
6. **No unified suite.** A11y, GDPR, policy drift, and AI-disclosure exist as disjoint
   single-topic projects with inconsistent methodology; nobody offers one coherent,
   rendered-browser-first compliance suite with evidence-grade outputs (VPAT/ACR,
   EAA/BFSG declarations, WEC-style evidence bundles) generated from actual scan
   artifacts.
7. **Site-wide orchestration is weak in agent land.** Existing MCPs audit one URL per
   call; crawling/sampling orchestration (unlighthouse/pa11y-ci-style) driven by an
   agent is absent.

**Constraint check — tools satisfying "full page context, never isolated component
renders":** axe-core (injected into live DOM), Lighthouse, pa11y (headless Chrome),
IBM Equal Access (Selenium/Puppeteer/Playwright), WAVE API ("after scripting has been
applied"), Playwright ariaSnapshot, WEC, Blacklight, and the OpenWPM-based CookieBlock
crawler all evaluate fully rendered pages and are safe foundations. Static-markup
linters and component-isolation harnesses are the ones to exclude.
