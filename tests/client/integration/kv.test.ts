import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisClient } from '../../../src/client/client.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

describe('integration: kv @integration', () => {
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

  it('SET then GET round-trips a string value', async ({ skip }) => {
    if (!available) skip();
    const key = `test:kv:${Date.now()}`;
    await client.set(key, 'hello');
    await expect(client.get(key)).resolves.toBe('hello');
    await client.del(key);
  });

  it('GET returns null for a missing key', async ({ skip }) => {
    if (!available) skip();
    await expect(client.get(`test:missing:${Date.now()}`)).resolves.toBeNull();
  });

  it('DEL removes a key', async ({ skip }) => {
    if (!available) skip();
    const key = `test:del:${Date.now()}`;
    await client.set(key, 'x');
    await expect(client.del(key)).resolves.toBe(1);
    await expect(client.get(key)).resolves.toBeNull();
  });

  it('EXPIRE sets a TTL', async ({ skip }) => {
    if (!available) skip();
    const key = `test:expire:${Date.now()}`;
    await client.set(key, 'x');
    await expect(client.expire(key, 60)).resolves.toBe(1);
    await client.del(key);
  });

  it('INCR increments a counter', async ({ skip }) => {
    if (!available) skip();
    const key = `test:incr:${Date.now()}`;
    await expect(client.incr(key)).resolves.toBe(1);
    await expect(client.incr(key)).resolves.toBe(2);
    await client.del(key);
  });

  it('HSET and HGET store hash fields', async ({ skip }) => {
    if (!available) skip();
    const key = `test:hash:${Date.now()}`;
    await expect(client.hset(key, 'field', 'value')).resolves.toBe(1);
    await expect(client.hget(key, 'field')).resolves.toBe('value');
    await expect(client.hget(key, 'missing')).resolves.toBeNull();
    await client.del(key);
  });
});
