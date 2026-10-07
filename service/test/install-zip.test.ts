import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { startService, stopAll, tempDir } from './helpers.js';

afterEach(stopAll);

// R5: GET /api/sites/:domain/install.zip — the two client files (from a built
// client dir), the snippet, the change list and INSTALL.txt.

function fixtureDist(): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'complykit-consent.js'), '/* core */');
  fs.writeFileSync(path.join(dir, 'complykit-consent-ui.js'), '/* ui */');
  return dir;
}

function unzip(buf: Buffer): Map<string, string> {
  const tmp = tempDir();
  const zipFile = path.join(tmp, 'x.zip');
  fs.writeFileSync(zipFile, buf);
  const out = path.join(tmp, 'out');
  execFileSync('unzip', ['-q', zipFile, '-d', out]);
  const files = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(out, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files.set(r, fs.readFileSync(path.join(out, r), 'utf8'));
    }
  };
  walk('');
  return files;
}

const snippet = (src: string) => `<script type="application/json" id="complykit-config">{}</script>\n<script src="${src}"></script>`;

async function store(s: Awaited<ReturnType<typeof startService>>, value: unknown): Promise<void> {
  await request(s.app).patch('/api/sites/example.com/workspace').send({ by: 'Ann', config: { value } }).expect(200);
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('GET /api/sites/:domain/install.zip', () => {
  it('zips the client files at the script path, the snippet, the change list and INSTALL.txt', async () => {
    const s = await startService({ consentClientDist: fixtureDist() });
    const src = '/complykit/v1/complykit-consent.js';
    await store(s, { config: {}, snippet: snippet(src), changeList: '# Change list\n', notes: [], scriptSrc: src });
    const res = await request(s.app).get('/api/sites/example.com/install.zip').buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/complykit-install-example\.com\.zip/);
    const files = unzip(res.body as Buffer);
    expect([...files.keys()].sort()).toEqual(['INSTALL.txt', 'change-list.md', 'complykit/v1/complykit-consent-ui.js', 'complykit/v1/complykit-consent.js', 'snippet.html']);
    expect(files.get('complykit/v1/complykit-consent.js')).toBe('/* core */');
    expect(files.get('complykit/v1/complykit-consent-ui.js')).toBe('/* ui */');
    expect(files.get('snippet.html')).toContain(`<script src="${src}">`);
    expect(files.get('change-list.md')).toBe('# Change list\n');
    expect(files.get('INSTALL.txt')).toContain(src);
    expect(files.get('INSTALL.txt')).toMatch(/Verify/);
  });

  it('follows a custom script src (folder and file name), read from the snippet when scriptSrc is not stored', async () => {
    const s = await startService({ consentClientDist: fixtureDist() });
    await store(s, { config: {}, snippet: snippet('/assets/ck/consent.js'), changeList: '', notes: [] });
    const res = await request(s.app).get('/api/sites/example.com/install.zip').buffer(true).parse(binary).expect(200);
    const files = unzip(res.body as Buffer);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['assets/ck/consent.js', 'assets/ck/complykit-consent-ui.js']));
  });

  it('404 without a generated config, 503 when the client files are missing', async () => {
    const s = await startService({ consentClientDist: fixtureDist() });
    const none = await request(s.app).get('/api/sites/example.com/install.zip').expect(404);
    expect(none.body.error).toMatch(/generate the config first/);
    const t = await startService({ consentClientDist: path.join(tempDir(), 'nope') });
    await request(t.app).patch('/api/sites/example.com/workspace').send({ by: 'Ann', config: { value: { config: {}, snippet: snippet('/complykit/v1/complykit-consent.js'), changeList: '', notes: [] } } }).expect(200);
    const res = await request(t.app).get('/api/sites/example.com/install.zip').expect(503);
    expect(res.body.error).toMatch(/consent client is not built/);
  });
});
