import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpacesBlobs } from '../src/server/storage/spaces-blobs.js';
import { mongoRecords } from '../src/server/storage/mongo.js';
import type { Storage } from '../src/server/storage/types.js';
import { blobSuite, recordSuite } from './storage-conformance.js';

// The cloud backend. Mongo always runs (in-memory server). Spaces runs only when
// TEST_SPACES_ENDPOINT, TEST_SPACES_BUCKET, TEST_SPACES_KEY and TEST_SPACES_SECRET
// are set; each run works under its own prefix and deletes it afterwards.

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
});

recordSuite('mongo', async ({ consentMaxBytes }) => {
  const db = `ck_test_${crypto.randomBytes(4).toString('hex')}`;
  const records = await mongoRecords({ url: mongo.getUri(), db, consentMaxBytes });
  const storage: Storage = { kind: 'cloud', blobs: undefined as never, ...records, close: records.close };
  return {
    storage,
    cleanup: async () => {
      // records.close() ran already; drop with a fresh connection.
      const again = await mongoRecords({ url: mongo.getUri(), db });
      await again.dropDatabase();
      await again.close();
    },
    corruptWorkspace: (domain) => records.corruptWorkspaceForTest(domain),
  };
});

const env = process.env;
const spacesConfigured = env.TEST_SPACES_ENDPOINT && env.TEST_SPACES_BUCKET && env.TEST_SPACES_KEY && env.TEST_SPACES_SECRET;
if (spacesConfigured) {
  blobSuite('spaces', async () => {
    const blobs = new SpacesBlobs({ endpoint: env.TEST_SPACES_ENDPOINT!, region: 'us-east-1', bucket: env.TEST_SPACES_BUCKET!, accessKeyId: env.TEST_SPACES_KEY!, secretAccessKey: env.TEST_SPACES_SECRET! });
    const root = `test-runs/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/`;
    return { blobs, root, cleanup: async () => void (await blobs.deletePrefix(root)) };
  });
} else {
  describe('spaces: blobs', () => {
    it.skip('set TEST_SPACES_ENDPOINT/BUCKET/KEY/SECRET to run against a real bucket', () => {});
  });
}

describe('mongo: prune keeps the site totals exact', () => {
  it('recomputes the total from the remaining records (an over-counted total is corrected)', async () => {
    const db = `ck_test_${crypto.randomBytes(4).toString('hex')}`;
    const records = await mongoRecords({ url: mongo.getUri(), db });
    const client = new MongoClient(mongo.getUri());
    try {
      const rec = (id: string, receivedAt: string) => ({ id, at: receivedAt, receivedAt, categories: { analytics: true }, configHash: 'sha256:ab12cd34', toolVersion: '0.1.0', regime: 'opt-in' }) as never;
      await records.consentRecords.append('shop.example', rec('old-0000000000000000', '2020-01-01T00:00:00.000Z'));
      await records.consentRecords.append('shop.example', rec('new-0000000000000000', new Date().toISOString()));
      const totals = client.db(db).collection<{ _id: string; bytes: number }>('consentTotals');
      const before = (await totals.findOne({ _id: 'shop.example' }))!.bytes;
      await totals.updateOne({ _id: 'shop.example' }, { $inc: { bytes: 100_000 } }); // as if an earlier prune died between deleteMany and the update
      expect(await records.consentRecords.prune(Date.parse('2025-01-01T00:00:00.000Z'))).toBe(1);
      const after = (await totals.findOne({ _id: 'shop.example' }))!.bytes;
      expect(after).toBe(before / 2);
    } finally {
      await client.close();
      await records.dropDatabase();
      await records.close();
    }
  });
});
