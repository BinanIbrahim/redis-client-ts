import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisClient } from '../../../src/client/client.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

describe('integration: pipelining @integration', () => {
  let client: RedisClient;
  let available = false;

  beforeAll(async () => {
    client = new RedisClient();
    try {
      await client.connect(REDIS_URL);
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(() => {
    if (available) client.disconnect();
  });

  it('issues parallel GETs over one connection (pipelined)', async ({ skip }) => {
    if (!available) skip();
    const prefix = `test:pipe:${Date.now()}`;
    const k1 = `${prefix}:1`;
    const k2 = `${prefix}:2`;

    await client.set(k1, 'alpha');
    await client.set(k2, 'beta');

    const [v1, v2] = await Promise.all([client.get(k1), client.get(k2)]);
    expect(v1).toBe('alpha');
    expect(v2).toBe('beta');

    await client.del(k1);
    await client.del(k2);
  });
});
