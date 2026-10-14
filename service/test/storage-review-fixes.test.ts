import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copyMissingRecords } from '../scripts/migrate-to-cloud.js';
import { fsStorage } from '../src/server/storage/fs.js';
import { SpacesBlobs } from '../src/server/storage/spaces-blobs.js';
import { tempDir } from './helpers.js';

const rec = (id: string) => ({ id, at: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z', categories: { analytics: true }, configHash: 'sha256:ab12cd34', toolVersion: '0.1.0', regime: 'opt-in' }) as never;
const ids = async (s: ReturnType<typeof fsStorage>, d: string) => {
  const out: string[] = [];
  for await (const r of s.consentRecords.records(d)) out.push(r.id);
  return out;
};

describe('migrate-to-cloud: consent records', () => {
  it('completes an interrupted copy (only the missing ids) and leaves a finished one alone', async () => {
    const src = fsStorage(tempDir());
    const dst = fsStorage(tempDir());
    for (const id of ['r1', 'r2', 'r3']) await src.consentRecords.append('shop.example', rec(id));
    await dst.consentRecords.append('shop.example', rec('r1')); // the copy died after the first record
    expect(await copyMissingRecords(src, dst, 'shop.example')).toBe(2);
    expect(await ids(dst, 'shop.example')).toEqual(['r1', 'r2', 'r3']);
    expect(await copyMissingRecords(src, dst, 'shop.example')).toBe(0);
    expect(await ids(dst, 'shop.example')).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('SpacesBlobs.download', () => {
  it('refuses a listed key that could leave the target directory', async () => {
    const blobs = new SpacesBlobs({ endpoint: 'http://localhost:1', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' });
    (blobs as unknown as { s3: { send: () => Promise<unknown> } }).s3 = { send: async () => ({ Contents: [{ Key: 'kb/../../evil.txt', Size: 1, ETag: 'x', LastModified: new Date() }], IsTruncated: false }) };
    const dir = tempDir();
    await expect(blobs.download('kb/', dir)).rejects.toThrow(/not a usable blob key/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('report config injection streams', () => {
  it('finds the workbench marker even when it straddles a chunk boundary, and passes other bytes unchanged', async () => {
    const { Readable } = await import('node:stream');
    const { serviceConfigInjector, reportServiceConfig } = await import('../src/server/report-config.js');
    const config = reportServiceConfig({ id: 'abcdef12', url: 'https://shop.example.com/' })!;
    const marker = '<script type="application/json" id="workspace-config">';
    const html = `<html><head>é${'x'.repeat(50)}${marker}{}</script></head></html>`;
    const bytes = Buffer.from(html);
    const at = bytes.indexOf(marker) + 20; // split in the middle of the marker
    for (const cut of [at, at - 19, bytes.indexOf(marker) + marker.length - 1]) {
      const out: Buffer[] = [];
      for await (const c of Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]).pipe(serviceConfigInjector(config))) out.push(c as Buffer);
      const text = Buffer.concat(out).toString('utf8');
      expect(text.indexOf('id="ck-service"')).toBeGreaterThan(0);
      expect(text.indexOf('id="ck-service"')).toBeLessThan(text.indexOf('id="workspace-config"'));
      expect(text.replace(/<script type="application\/json" id="ck-service">.*?<\/script>/, '')).toBe(html);
    }
    // No marker: byte-identical, however it is chunked.
    const plain = Buffer.from('<html>no workbench here, just ' + 'y'.repeat(200) + '</html>');
    const out: Buffer[] = [];
    for await (const c of Readable.from([plain.subarray(0, 7), plain.subarray(7, 100), plain.subarray(100)]).pipe(serviceConfigInjector(config))) out.push(c as Buffer);
    expect(Buffer.concat(out).equals(plain)).toBe(true);
  });
});
