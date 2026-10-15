import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdnPurger } from '../src/server/cdn.js';
import { configHash } from '../src/server/config-hash.js';
import { CONSENT_SETTINGS_KEY, normalizeConsentSettings } from '../src/server/consent-settings.js';
import { hostedConfig } from '../src/server/hosted-script.js';
import { storedTasks } from '../src/server/remediation.js';
import { WorkspaceError } from '../src/server/workspace.js';
import { startService, stopAll, tempDir } from './helpers.js';

// T7 contract (plans/hosted-script.md "Owner settings", "Add-on mode").

afterEach(stopAll);

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const example = (): Record<string, any> => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const ORIGIN = 'https://ck.example-host.test';
const DOMAIN = 'example-shop.test';

function fakeDist(): string {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'complykit-consent.js'), '/*core*/\n');
  fs.writeFileSync(path.join(d, 'complykit-consent-ui.js'), '/*ui*/\n');
  return d;
}

const task = (id: string, kind: string) => ({ id, kind, group: 'install', title: id, summary: '', steps: [], pages: [], verify: { check: 'manual', method: 'manual', reason: 'x' }, optional: false, notes: [], status: 'todo', order: 0, aliases: [], alsoFixes: [] });

async function service() {
  const purged: string[][] = [];
  const purger: CdnPurger = { purgeUrls: async (u) => void purged.push(u), purgeAll: async () => {} };
  const s = await startService({ consentClientDist: fakeDist(), publicOrigin: ORIGIN }, {}, { purger });
  await s.workspaces.patch(DOMAIN, {
    config: { value: { config: example(), snippet: '', changeList: '', notes: [], detectedCmp: 'onetrust', tasks: [task('install', 'install'), task('remove-existing-tool:aaaaaaaaaaaa', 'remove-existing-tool'), task('rewrite-tag:bbbbbbbbbbbb', 'rewrite-tag')] } },
  });
  return { s, purged };
}

const served = async (s: Awaited<ReturnType<typeof startService>>) => JSON.parse((await request(s.app).get(`/s/${DOMAIN}.js`).expect(200)).text.split('\n')[1].replace(/^window\.ComplyKitConfig=/, '').replace(/;$/, ''));

describe('normalizeConsentSettings', () => {
  it('accepts the allow-listed fields', () => {
    expect(normalizeConsentSettings({ mode: 'full', layout: 'box', blockPage: true, privacyPolicyUrl: 'https://example-shop.test/privacy' })).toEqual({ mode: 'full', layout: 'box', blockPage: true, privacyPolicyUrl: 'https://example-shop.test/privacy' });
    expect(normalizeConsentSettings({ mode: 'companion', cmp: 'cookiebot' })).toEqual({ mode: 'companion', cmp: 'cookiebot' });
  });

  it('refuses anything else with a 400', () => {
    const bad = [
      null,
      'full',
      {},
      { mode: 'other' },
      { mode: 'companion' },
      { mode: 'companion', cmp: 'acme' },
      { mode: 'full', layout: 'popup' },
      { mode: 'full', blockPage: 'yes' },
      { mode: 'full', privacyPolicyUrl: 'http://example-shop.test/privacy' },
      { mode: 'full', privacyPolicyUrl: 'javascript:alert(1)' },
      { mode: 'full', extra: 1 },
    ];
    for (const b of bad) {
      let err: unknown;
      try {
        normalizeConsentSettings(b);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(b)).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).status).toBe(400);
    }
  });
});

describe('hostedConfig with settings', () => {
  it('full: layout, blockPage and privacy link land in the served config, re-hashed', () => {
    const out = hostedConfig(example(), ORIGIN, { mode: 'full', layout: 'modal', blockPage: true, privacyPolicyUrl: 'https://example-shop.test/privacy' });
    expect(out).toMatchObject({ layout: 'modal', blockPage: true, privacyPolicyUrl: 'https://example-shop.test/privacy' });
    expect(out.mode).toBeUndefined();
    expect(out.companion).toBeUndefined();
    expect(out.hash).toBe(configHash(out));
  });

  it('companion: mode + cmp, no consent record endpoint, analytics kept', () => {
    const out = hostedConfig(example(), ORIGIN, { mode: 'companion', cmp: 'onetrust' });
    expect(out).toMatchObject({ mode: 'companion', companion: { cmp: 'onetrust' }, analytics: { endpoint: `${ORIGIN}/e` } });
    expect(out.record).toBeUndefined();
    expect(out.hash).toBe(configHash(out));
  });

  it('settings only set what they name', () => {
    const out = hostedConfig(example(), ORIGIN, { mode: 'full' });
    expect(out.layout).toBe(example().layout);
  });
});

describe('PUT /api/sites/:domain/consent-settings', () => {
  it('stores the settings, serves them, purges the script URL', async () => {
    const { s, purged } = await service();
    purged.length = 0;
    const res = await request(s.app).put(`/api/sites/${DOMAIN}/consent-settings`).send({ mode: 'companion', cmp: 'onetrust' }).expect(200);
    expect(res.body).toMatchObject({ settings: { mode: 'companion', cmp: 'onetrust' } });
    expect((await s.workspaces.get(DOMAIN)).entries[CONSENT_SETTINGS_KEY]?.value).toEqual({ mode: 'companion', cmp: 'onetrust' });
    expect(await served(s)).toMatchObject({ mode: 'companion', companion: { cmp: 'onetrust' } });
    await vi.waitFor(() => expect(purged).toContainEqual([`${ORIGIN}/s/${DOMAIN}.js`]));
  });

  it('GET returns the settings (default full) and the detected banner', async () => {
    const { s } = await service();
    expect((await request(s.app).get(`/api/sites/${DOMAIN}/consent-settings`).expect(200)).body).toEqual({ settings: { mode: 'full' }, detectedCmp: 'onetrust' });
  });

  it('400 on bad settings; nothing stored', async () => {
    const { s } = await service();
    await request(s.app).put(`/api/sites/${DOMAIN}/consent-settings`).send({ mode: 'companion' }).expect(400);
    expect((await s.workspaces.get(DOMAIN)).entries[CONSENT_SETTINGS_KEY]).toBeUndefined();
  });

  it('a bad stored entry (written around the route) is ignored when serving', async () => {
    const { s } = await service();
    await s.workspaces.patch(DOMAIN, { entries: { [CONSENT_SETTINGS_KEY]: { value: { mode: 'companion', cmp: 'acme' } } } });
    expect((await served(s)).mode).toBeUndefined();
  });
});

describe('the to-do list in add-on mode', () => {
  it('hides remove-existing-tool tasks; the rest stay', async () => {
    const { s } = await service();
    expect(storedTasks(await s.workspaces.get(DOMAIN)).map((t) => t.kind)).toEqual(['install', 'remove-existing-tool', 'rewrite-tag']);
    await request(s.app).put(`/api/sites/${DOMAIN}/consent-settings`).send({ mode: 'companion', cmp: 'onetrust' }).expect(200);
    expect(storedTasks(await s.workspaces.get(DOMAIN)).map((t) => t.kind)).toEqual(['install', 'rewrite-tag']);
    const view = (await request(s.app).get(`/api/sites/${DOMAIN}/remediation`).expect(200)).body;
    expect(view.tasks.map((t: { kind: string }) => t.kind)).toEqual(['install', 'rewrite-tag']);
  });
});
