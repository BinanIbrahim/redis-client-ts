import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisConnection } from '../../../src/client/connection.js';
import { RedisLock } from '../../../src/patterns/lock.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('integration: distributed lock @integration', () => {
  // Two independent connections so contention is real: holder A and contender
  // B race against each other on the wire, not against each other's queued
  // commands on the same socket. Release uses WATCH/MULTI/EXEC which is
  // connection-scoped, so this isolation is also required for correctness.
  let connA: RedisConnection;
  let connB: RedisConnection;
  let lockA: RedisLock;
  let lockB: RedisLock;
  let available = false;

  beforeAll(async () => {
    connA = new RedisConnection();
    connB = new RedisConnection();
    try {
      await connA.connect(REDIS_URL);
      await connB.connect(REDIS_URL);
      lockA = new RedisLock(connA);
      lockB = new RedisLock(connB);
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(() => {
    if (available) {
      connA.disconnect();
      connB.disconnect();
    }
  });

  it('grants exclusive access; B cannot acquire while A holds', async ({ skip }) => {
    if (!available) skip();
    const key = `test:lock:mutex:${Date.now()}`;

    const heldByA = await lockA.acquire(key, { ttlMs: 5000 });
    expect(heldByA).not.toBeNull();

    const deniedToB = await lockB.acquire(key, { ttlMs: 5000 });
    expect(deniedToB).toBeNull();

    await heldByA!.release();

    const grantedToB = await lockB.acquire(key, { ttlMs: 5000 });
    expect(grantedToB).not.toBeNull();
    await grantedToB!.release();
  });

  it('TTL expiry allows a new acquire even if release was never called', async ({
    skip,
  }) => {
    if (!available) skip();
    const key = `test:lock:ttl:${Date.now()}`;
    const ttlMs = 200;

    const first = await lockA.acquire(key, { ttlMs });
    expect(first).not.toBeNull();
    // Intentionally do NOT release.

    // Before the TTL fires, B should still be denied.
    const stillDenied = await lockB.acquire(key, { ttlMs });
    expect(stillDenied).toBeNull();

    // After TTL, Redis drops the key and B can take it.
    await delay(ttlMs + 50);
    const granted = await lockB.acquire(key, { ttlMs });
    expect(granted).not.toBeNull();
    await granted!.release();
  });

  it('fencing tokens are strictly monotonic across sequential acquires', async ({
    skip,
  }) => {
    if (!available) skip();
    const key = `test:lock:fence:${Date.now()}`;

    const tokens: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const held = await lockA.acquire(key, { ttlMs: 5000 });
      expect(held).not.toBeNull();
      tokens.push(held!.token);
      await held!.release();
    }

    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]! > tokens[i - 1]!).toBe(true);
    }
  });

  it('release after the lock expired does not delete a re-acquired lock', async ({
    skip,
  }) => {
    if (!available) skip();
    const key = `test:lock:safe-release:${Date.now()}`;
    const ttlMs = 200;

    const stale = await lockA.acquire(key, { ttlMs });
    expect(stale).not.toBeNull();

    // Let A's lock expire, then B takes it.
    await delay(ttlMs + 50);
    const held = await lockB.acquire(key, { ttlMs: 5000 });
    expect(held).not.toBeNull();

    // A's release (with its stale secret) must NOT delete B's lock.
    await stale!.release();

    // B should still hold the lock — proven by a third acquire being denied.
    const denied = await lockA.acquire(key, { ttlMs: 5000 });
    expect(denied).toBeNull();

    await held!.release();
  });
});
