import fs from 'node:fs';
import path from 'node:path';
import type { Artifact } from '../../record/index.js';
import type { Discovered } from './discover.js';

// Pass 2 (static-analysis-design.md): the inventories nothing off-the-shelf
// emits in our record format — server-side code invisible to a browser scan.
// Mechanics: literal pre-filter, then read the candidate. No full TS program;
// these rules do not need types. Confidence is left to the rules that consume
// these artifacts (trackers/ai-frameworks are provable presence -> violation;
// pii is heuristic -> needs-review).

export interface InventoryItem {
  name: string; // package / field / domain matched
  file: string; // repo-relative
  line: number;
  evidence: string; // the matched line, trimmed
  detail?: string; // e.g. import specifier, model name
}

const AI_FRAMEWORK_PACKAGES = [
  'openai', '@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk', 'langchain', '@langchain/core',
  '@langchain/openai', 'ollama', '@google/generative-ai', 'cohere-ai', 'replicate',
  'together-ai', 'groq-sdk', '@mistralai/mistralai', '@huggingface/inference', 'ai',
];

const TRACKER_PACKAGES = [
  'mixpanel', 'mixpanel-browser', 'posthog-js', 'posthog-node', '@sentry/browser',
  '@sentry/node', '@sentry/react', '@sentry/vue', 'amplitude-js', '@amplitude/analytics-browser',
  '@segment/analytics-next', 'analytics-node', 'react-ga', 'react-ga4', 'vue-gtag',
  '@fullstory/browser', 'hotjar', 'react-hotjar', 'heap-api',
];

const TRACKER_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'connect.facebook.net',
  'facebook.com/tr', 'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'sentry.io',
  'amplitude.com', 'fullstory.com', 'clarity.ms', 'matomo',
];

const PII_FIELD = /\b(e-?mail|phone|mobile|dob|date_?of_?birth|birth_?date|ssn|social_?security|passport|national_?id|street_?address|postal_?code|zip_?code|first_?name|last_?name|full_?name|credit_?card|card_?number|iban|tax_?id)\b/i;
const SCHEMA_HINT = /(new\s+(mongoose\.)?Schema|z\.object|@Column|@Prop|Prisma|sequelize\.define|DataTypes|type\s+\w+\s*=\s*\{)/;

function importSpecifiers(content: string): Array<{ spec: string; line: number; text: string }> {
  const out: Array<{ spec: string; line: number; text: string }> = [];
  const lines = content.split('\n');
  const re = /(?:import\s[^'"]*from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  lines.forEach((text, i) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) out.push({ spec: m[1], line: i + 1, text: text.trim() });
  });
  return out;
}

function matchPackage(spec: string, list: string[]): string | undefined {
  return list.find((p) => spec === p || spec.startsWith(p + '/'));
}

export interface InventoryResult {
  artifacts: Artifact[];
  hasAiFeatures: boolean;
}

export function scanInventories(discovered: Discovered, capturedAt: string, property: string): InventoryResult {
  const ai: InventoryItem[] = [];
  const trackers: InventoryItem[] = [];
  const pii: InventoryItem[] = [];

  const scannable = discovered.files.filter((f) => /\.(js|jsx|mjs|cjs|ts|tsx|vue)$/.test(f));

  for (const rel of scannable) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(discovered.root, rel), 'utf8');
    } catch {
      continue;
    }

    for (const imp of importSpecifiers(content)) {
      const aiPkg = matchPackage(imp.spec, AI_FRAMEWORK_PACKAGES);
      if (aiPkg) ai.push({ name: aiPkg, file: rel, line: imp.line, evidence: imp.text, detail: imp.spec });
      const trPkg = matchPackage(imp.spec, TRACKER_PACKAGES);
      if (trPkg) trackers.push({ name: trPkg, file: rel, line: imp.line, evidence: imp.text, detail: imp.spec });
    }

    // Tracker domains in string literals (script src, fetch, pixel).
    const lines = content.split('\n');
    lines.forEach((text, i) => {
      for (const domain of TRACKER_DOMAINS) {
        if (text.includes(domain)) {
          trackers.push({ name: domain, file: rel, line: i + 1, evidence: text.trim().slice(0, 200) });
          break;
        }
      }
    });

    // PII schema surface: only in files that look like a data model.
    if (SCHEMA_HINT.test(content)) {
      lines.forEach((text, i) => {
        const m = text.match(PII_FIELD);
        if (m && /[:=]/.test(text)) {
          pii.push({ name: m[0].toLowerCase(), file: rel, line: i + 1, evidence: text.trim().slice(0, 200) });
        }
      });
    }
  }

  const artifacts: Artifact[] = [];
  const mk = (category: 'tracker' | 'ai-framework' | 'pii', items: InventoryItem[]): void => {
    if (!items.length) return;
    artifacts.push({
      kind: 'inventory',
      subject: { property },
      capturedAt,
      category,
      items: items as unknown as Record<string, unknown>[],
    });
  };
  mk('ai-framework', ai);
  mk('tracker', trackers);
  mk('pii', pii);

  return { artifacts, hasAiFeatures: ai.length > 0 };
}
