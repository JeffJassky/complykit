import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildVueScopeMap, enrichFindingsWithVueSource } from '../src/enrich/vue-scope.js';
import { asRuleId, asRequirementId, asRunId, fingerprint, type Finding } from '../src/index.js';

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-vue-'));
  fs.mkdirSync(path.join(dir, 'src/client/src/views'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/client/src/views/Detail.vue'), '<template><div/></template>');
  fs.mkdirSync(path.join(dir, 'node_modules/junk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/junk/Skip.vue'), 'x');
  return dir;
}

function mkFinding(html: string): Finding {
  const subject = { property: 'app', routePattern: '/x', locator: { role: 'generic', ordinal: 0 } };
  return {
    schemaVersion: 1,
    ruleId: asRuleId('axe-core:aria-hidden-focus'),
    requirementId: asRequirementId('wcag22.4.1.2'),
    subject,
    confidence: 'violation',
    severity: 'critical',
    message: 'm',
    evidence: [{ kind: 'dom-snippet', html }],
    fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:aria-hidden-focus'), subject }),
    producer: { type: 'engine', name: 'axe-core', version: '4' },
    runId: asRunId('2026-08-20T00-00-00.000Z'),
  };
}

describe('vue scope map', () => {
  it('maps every path suffix (any vite root) and skips node_modules', () => {
    const repo = mkRepo();
    const map = buildVueScopeMap(repo);
    const rel = path.join('src', 'client', 'src', 'views', 'Detail.vue');
    // vite root = repo, = src/client, = deep — all suffixes resolve
    expect(map.get(short('src/client/src/views/Detail.vue'))).toBe(rel);
    expect(map.get(short('src/views/Detail.vue'))).toBe(rel);
    expect(map.get(short('Detail.vue'))).toBe(rel);
    expect([...map.values()]).not.toContain(expect.stringContaining('node_modules'));
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('enriches findings via data-v markers without touching fingerprints', () => {
    const repo = mkRepo();
    const map = buildVueScopeMap(repo);
    const id = short('src/views/Detail.vue'); // vite root = src/client
    const f = mkFinding(`<div data-v-${id} class="dom-head" aria-hidden="true">`);
    const before = f.fingerprint;
    const res = enrichFindingsWithVueSource([f], map);
    expect(res.enriched).toBe(1);
    expect(f.subject.file?.path).toBe(path.join('src', 'client', 'src', 'views', 'Detail.vue'));
    expect(f.fingerprint).toBe(before);
    // unknown scope id → untouched
    const g = mkFinding('<div data-v-deadbeef>');
    expect(enrichFindingsWithVueSource([g], map).enriched).toBe(0);
    expect(g.subject.file).toBeUndefined();
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
