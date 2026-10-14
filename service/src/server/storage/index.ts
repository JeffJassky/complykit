import { cloudStorage } from './cloud.js';
import { fsStorage } from './fs.js';
import type { CloudStorageConfig, Storage } from './types.js';

export * from './types.js';
export { FsBlobs } from './fs-blobs.js';
export { fsStorage } from './fs.js';
export { SpacesBlobs } from './spaces-blobs.js';
export { mongoRecords } from './mongo.js';
export { cloudStorage } from './cloud.js';

export async function openStorage(c: { dataBackend: 'fs' | 'cloud'; dataDir: string; cloud?: CloudStorageConfig; consentMaxBytes?: number }): Promise<Storage> {
  if (c.dataBackend === 'fs') return fsStorage(c.dataDir, { consentMaxBytes: c.consentMaxBytes });
  if (c.dataBackend === 'cloud') {
    if (!c.cloud) throw new Error("DATA_BACKEND=cloud needs the cloud settings (MONGO_URL, SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET)");
    return cloudStorage(c.cloud, { consentMaxBytes: c.consentMaxBytes });
  }
  throw new Error(`unknown data backend: ${String((c as { dataBackend: unknown }).dataBackend)}`);
}
