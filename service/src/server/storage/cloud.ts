// The cloud backend: files in Spaces, records in MongoDB (plans/do-hosting.md).

import { mongoRecords } from './mongo.js';
import { SpacesBlobs } from './spaces-blobs.js';
import type { CloudStorageConfig, Storage } from './types.js';

export async function cloudStorage(cfg: CloudStorageConfig, opts: { consentMaxBytes?: number } = {}): Promise<Storage> {
  const records = await mongoRecords({ url: cfg.mongoUrl, db: cfg.mongoDb, ca: cfg.mongoCa, consentMaxBytes: opts.consentMaxBytes });
  return {
    kind: 'cloud',
    blobs: new SpacesBlobs(cfg.spaces),
    jobs: records.jobs,
    workspaces: records.workspaces,
    consentRecords: records.consentRecords,
    close: records.close,
  };
}
