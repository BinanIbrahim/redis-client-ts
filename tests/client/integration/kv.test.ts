import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisClient } from '../../../src/client/client.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

let redisAvailable = false;

beforeAll(async () => {
  const client = new RedisClient();
  try {
    await client.connect(REDIS_URL);
    client.disconnect();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

describe('integration: kv @integration', () => {
  let client: RedisClient;

  beforeAll(async () => {
    if (!redisAvailable) return;
    client = new RedisClient();
    await client.connect(REDIS_URL);
  });

  afterAll(() => {
    client?.disconnect();
  });

  it.skipIf(!redisAvailable)('SET then GET round-trips a string value', async () => {
    const key = `test:kv:${Date.now()}`;
    await client.set(key, 'hello');
    await expect(client.get(key)).resolves.toBe('hello');
    await client.del(key);
  });

  it.skipIf(!redisAvailable)('GET returns null for a missing key', async () => {
    await expect(client.get(`test:missing:${Date.now()}`)).resolves.toBeNull();
  });

  it.skipIf(!redisAvailable)('DEL removes a key', async () => {
    const key = `test:del:${Date.now()}`;
    await client.set(key, 'x');
    await expect(client.del(key)).resolves.toBe(1);
    await expect(client.get(key)).resolves.toBeNull();
  });

  it.skipIf(!redisAvailable)('EXPIRE sets a TTL', async () => {
    const key = `test:expire:${Date.now()}`;
    await client.set(key, 'x');
    await expect(client.expire(key, 60)).resolves.toBe(1);
    await client.del(key);
  });

  it.skipIf(!redisAvailable)('INCR increments a counter', async () => {
    const key = `test:incr:${Date.now()}`;
    await expect(client.incr(key)).resolves.toBe(1);
    await expect(client.incr(key)).resolves.toBe(2);
    await client.del(key);
  });

  it.skipIf(!redisAvailable)('HSET and HGET store hash fields', async () => {
    const key = `test:hash:${Date.now()}`;
    await expect(client.hset(key, 'field', 'value')).resolves.toBe(1);
    await expect(client.hget(key, 'field')).resolves.toBe('value');
    await expect(client.hget(key, 'missing')).resolves.toBeNull();
    await client.del(key);
  });
});
