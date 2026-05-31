import { describe, it, expect, vi } from 'vitest';
import {
  TokenBucketRateLimiter,
  RateLimiterContentionError,
} from '../../src/patterns/rate-limiter.js';
import type { CommandRunner } from '../../src/client/command-runner.js';
import type { RespValue } from '../../src/protocol/types.js';

function scriptedRunner(responses: RespValue[]): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const queue = [...responses];
  return {
    calls,
    runner: {
      sendCommand: vi.fn((args: readonly string[]) => {
        calls.push([...args]);
        const next = queue.shift();
        if (!next) throw new Error(`unexpected sendCommand: ${args.join(' ')}`);
        return Promise.resolve(next);
      }),
    },
  };
}

const ok: RespValue = { type: 'simple', value: 'OK' };
const queued: RespValue = { type: 'simple', value: 'QUEUED' };
const integer = (n: number): RespValue => ({ type: 'integer', value: BigInt(n) });
const bulk = (s: string | null): RespValue => ({
  type: 'bulk',
  value: s === null ? null : Buffer.from(s),
});
const array = (items: RespValue[]): RespValue => ({ type: 'array', value: items });
const nullArray: RespValue = { type: 'array', value: null };

// Cold-start state (no key exists): HMGET returns an array of two null bulks.
const coldState = array([bulk(null), bulk(null)]);
const stateAt = (tokens: number, ts: number): RespValue =>
  array([bulk(String(tokens)), bulk(String(ts))]);

// EXEC commit result: the two queued commands' replies (HSET integer + PEXPIRE integer).
// The limiter doesn't inspect them, but the test runner returns realistic shapes.
const execOk = array([integer(2), integer(1)]);

describe('TokenBucketRateLimiter.tryAcquire', () => {
  it('cold start: first request allowed, bucket fills to capacity then decrements', async () => {
    const { runner, calls } = scriptedRunner([
      ok, // WATCH
      coldState, // HMGET
      ok, // MULTI
      queued, // HSET queued
      queued, // PEXPIRE queued
      execOk, // EXEC
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_000,
    });

    const result = await limiter.tryAcquire('user:42');

    expect(result).toEqual({ allowed: true, remaining: 9 });
    expect(calls[0]).toEqual(['WATCH', 'limiter:user:42']);
    expect(calls[1]).toEqual(['HMGET', 'limiter:user:42', 'tokens', 'ts']);
    expect(calls[2]).toEqual(['MULTI']);
    // HSET writes the new tokens count (9) and the current timestamp.
    expect(calls[3]?.slice(0, 2)).toEqual(['HSET', 'limiter:user:42']);
    expect(calls[3]).toContain('tokens');
    expect(calls[3]).toContain('9');
    expect(calls[3]).toContain('ts');
    expect(calls[3]).toContain('1000000');
    expect(calls[4]?.slice(0, 2)).toEqual(['PEXPIRE', 'limiter:user:42']);
    expect(calls[5]).toEqual(['EXEC']);
  });

  it('bucket empty and no time elapsed: denied with retryAfterMs for one token', async () => {
    const { runner, calls } = scriptedRunner([
      ok, // WATCH
      stateAt(0, 1_000_000), // HMGET — empty bucket as of "now"
      ok, // UNWATCH
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5, // → 200ms per token
      now: () => 1_000_000,
    });

    const result = await limiter.tryAcquire('user:42');

    expect(result).toEqual({ allowed: false, retryAfterMs: 200 });
    // Denied path issues no MULTI; only WATCH + HMGET + UNWATCH.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['UNWATCH']);
  });

  it('partial refill since last request: tokens add proportionally to elapsed time', async () => {
    // State was 0 tokens at t=1_000_000. Now is 1_000_400 (400ms later).
    // At 5 tokens/sec, 400ms = 2 tokens. We consume 1, leaving 1.
    const { runner } = scriptedRunner([
      ok,
      stateAt(0, 1_000_000),
      ok,
      queued,
      queued,
      execOk,
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_400,
    });

    const result = await limiter.tryAcquire('user:42');
    expect(result).toEqual({ allowed: true, remaining: 1 });
  });

  it('refill is capped at capacity for long idle periods', async () => {
    // State: 0 tokens at t=0. Now is t=1_000_000 (very long idle).
    // Naive refill = 5_000_000 tokens; must cap at capacity (10).
    const { runner } = scriptedRunner([
      ok,
      stateAt(0, 0),
      ok,
      queued,
      queued,
      execOk,
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_000,
    });

    const result = await limiter.tryAcquire('user:42');
    // 10 capped, minus 1 consumed.
    expect(result).toEqual({ allowed: true, remaining: 9 });
  });

  it('partial token (< 1) is denied with the correct retryAfterMs', async () => {
    // State: 0.5 tokens at t=1_000_000. Now is the same. Need 0.5 more
    // tokens; at 5 tokens/sec that's 100ms.
    const { runner } = scriptedRunner([ok, stateAt(0.5, 1_000_000), ok]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_000,
    });

    const result = await limiter.tryAcquire('user:42');
    expect(result).toEqual({ allowed: false, retryAfterMs: 100 });
  });

  it('retries when EXEC is aborted by WATCH, then succeeds', async () => {
    const { runner, calls } = scriptedRunner([
      // Attempt 1: aborted
      ok,
      coldState,
      ok,
      queued,
      queued,
      nullArray, // EXEC aborted
      // Attempt 2: succeeds
      ok,
      coldState,
      ok,
      queued,
      queued,
      execOk,
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_000,
    });

    const result = await limiter.tryAcquire('user:42');
    expect(result).toEqual({ allowed: true, remaining: 9 });
    // 6 commands per attempt × 2 attempts = 12.
    expect(calls).toHaveLength(12);
  });

  it('throws RateLimiterContentionError when all retries are aborted', async () => {
    const attempt = (): RespValue[] => [ok, coldState, ok, queued, queued, nullArray];
    const { runner } = scriptedRunner([
      ...attempt(),
      ...attempt(),
      ...attempt(), // default maxRetries: 3 attempts total
    ]);
    const limiter = new TokenBucketRateLimiter(runner, {
      capacity: 10,
      refillRatePerSec: 5,
      now: () => 1_000_000,
    });

    await expect(limiter.tryAcquire('user:42')).rejects.toBeInstanceOf(
      RateLimiterContentionError,
    );
  });
});
