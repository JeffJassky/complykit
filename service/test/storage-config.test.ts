import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const cloudEnv = { DATA_BACKEND: 'cloud', MONGO_URL: 'mongodb://m', SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com', SPACES_BUCKET: 'b', SPACES_KEY: 'k', SPACES_SECRET: 's' };

describe('storage config', () => {
  it('defaults to the fs backend with no cloud settings', () => {
    const c = loadConfig({});
    expect(c.dataBackend).toBe('fs');
    expect(c.cloud).toBeUndefined();
    expect(loadConfig({ DATA_BACKEND: 'fs', MONGO_URL: 'ignored' }).cloud).toBeUndefined();
  });

  it('reads the cloud settings, with defaults for db and region', () => {
    expect(loadConfig(cloudEnv).cloud).toEqual({
      mongoUrl: 'mongodb://m',
      mongoDb: 'complykit',
      spaces: { endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    });
    const c = loadConfig({ ...cloudEnv, MONGO_DB: 'other', SPACES_REGION: 'nyc3' });
    expect(c.cloud?.mongoDb).toBe('other');
    expect(c.cloud?.spaces.region).toBe('nyc3');
  });

  it('passes the Mongo CA (PEM text) through when MONGO_CA is set', () => {
    expect(loadConfig(cloudEnv).cloud?.mongoCa).toBeUndefined();
    expect(loadConfig({ ...cloudEnv, MONGO_CA: '' }).cloud).not.toHaveProperty('mongoCa');
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    expect(loadConfig({ ...cloudEnv, MONGO_CA: pem }).cloud?.mongoCa).toBe(pem);
  });

  it('names the missing cloud settings', () => {
    expect(() => loadConfig({ DATA_BACKEND: 'cloud' })).toThrow(/MONGO_URL, SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET/);
    expect(() => loadConfig({ ...cloudEnv, SPACES_SECRET: '' })).toThrow(/SPACES_SECRET/);
  });

  it('refuses an unknown backend', () => {
    expect(() => loadConfig({ DATA_BACKEND: 'mongo' })).toThrow(/DATA_BACKEND/);
  });
});
