import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisConnection } from '../../../src/client/connection.js';
import { TokenBucketRateLimiter } from '../../../src/patterns/rate-limiter.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('integration: token bucket rate limiter @integration', () => {
  // Two independent connections so the concurrency test sees real contention
  // on the wire, not commands serialized on a single socket.
  let connA: RedisConnection;
  let connB: RedisConnection;
  let available = false;

  beforeAll(async () => {
    connA = new RedisConnection();
    connB = new RedisConnection();
    try {
      await connA.connect(REDIS_URL);
      await connB.connect(REDIS_URL);
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

  it('cold start: first request returns capacity - 1 remaining', async ({ skip }) => {
    if (!available) skip();
    const key = `test:rl:cold:${Date.now()}`;
    const limiter = new TokenBucketRateLimiter(connA, {
      capacity: 10,
      refillRatePerSec: 5,
    });

    const result = await limiter.tryAcquire(key);
    expect(result).toEqual({ allowed: true, remaining: 9 });
  });

  it('burst up to capacity then deny: 10 allowed, 11th denied', async ({ skip }) => {
    if (!available) skip();
    const key = `test:rl:burst:${Date.now()}`;
    // Very slow refill so we don't accidentally earn a token mid-burst.
    const limiter = new TokenBucketRateLimiter(connA, {
      capacity: 10,
      refillRatePerSec: 0.1,
    });

    for (let i = 0; i < 10; i++) {
      const result = await limiter.tryAcquire(key);
      expect(result.allowed).toBe(true);
    }
    const denied = await limiter.tryAcquire(key);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('refills over time: a wait long enough for one token re-allows', async ({
    skip,
  }) => {
    if (!available) skip();
    const key = `test:rl:refill:${Date.now()}`;
    // 5 tokens/sec → 200ms per token. Capacity 1 so we drain instantly.
    const limiter = new TokenBucketRateLimiter(connA, {
      capacity: 1,
      refillRatePerSec: 5,
    });

    const first = await limiter.tryAcquire(key);
    expect(first.allowed).toBe(true);

    const immediate = await limiter.tryAcquire(key);
    expect(immediate.allowed).toBe(false);

    // Wait past one refill interval (200ms) plus a small margin.
    await delay(260);

    const afterRefill = await limiter.tryAcquire(key);
    expect(afterRefill.allowed).toBe(true);
  });

  it('concurrent acquirers respect the capacity bound', async ({ skip }) => {
    if (!available) skip();
    const key = `test:rl:concurrent:${Date.now()}`;
    // Capacity 5, very slow refill so the bucket can't replenish mid-test.
    // maxRetries bumped to make contention exhaustion essentially impossible
    // at this scale — we are validating the LIMIT, not the retry budget.
    const config = {
      capacity: 5,
      refillRatePerSec: 0.01,
      maxRetries: 50,
    };
    const limiterA = new TokenBucketRateLimiter(connA, config);
    const limiterB = new TokenBucketRateLimiter(connB, config);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).tryAcquire(key),
      ),
    );

    const allowed = attempts.filter((r) => r.allowed).length;
    const denied = attempts.length - allowed;

    // Exactly `capacity` allowed; the rest denied. This is the core safety
    // claim of the limiter under concurrency — WATCH/MULTI/EXEC must serialise
    // the contended writes so we never overshoot.
    expect(allowed).toBe(5);
    expect(denied).toBe(15);
  });
});
