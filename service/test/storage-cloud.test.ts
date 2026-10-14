import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, it } from 'vitest';
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
