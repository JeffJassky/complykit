import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsBlobs } from '../src/server/storage/fs-blobs.js';
import { fsStorage } from '../src/server/storage/fs.js';
import { blobSuite, recordSuite } from './storage-conformance.js';

// The fs backend: today's DATA_DIR layout, so existing data keeps working.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-fs-'));

blobSuite('fs', async () => {
  const dir = tmp();
  return { blobs: new FsBlobs(dir), root: '', cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
});

recordSuite('fs', async ({ consentMaxBytes }) => {
  const dir = tmp();
  const storage = fsStorage(dir, { consentMaxBytes });
  return {
    storage,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
    corruptWorkspace: async (domain) => {
      await fsp.mkdir(path.join(dir, 'sites', domain), { recursive: true });
      await fsp.writeFile(path.join(dir, 'sites', domain, 'workspace.json'), '{ not json');
    },
  };
});
