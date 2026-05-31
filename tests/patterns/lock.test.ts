import { describe, it, expect, vi } from 'vitest';
import { RedisLock } from '../../src/patterns/lock.js';
import type { CommandRunner } from '../../src/client/command-runner.js';
import type { RespValue } from '../../src/protocol/types.js';

/**
 * Test double: queues scripted responses and records every sendCommand call
 * with its args, so tests can assert on wire shape without running TCP.
 */
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
const nilBulk: RespValue = { type: 'bulk', value: null };
const integer = (n: number): RespValue => ({ type: 'integer', value: BigInt(n) });

describe('RedisLock.acquire', () => {
  it('issues SET NX PX then INCR <key>:fence and returns a lock', async () => {
    const { runner, calls } = scriptedRunner([ok, integer(1)]);
    const lock = new RedisLock(runner);

    const result = await lock.acquire('orders:42', { ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result!.token).toBe(1n);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(0, 2)).toEqual(['SET', 'orders:42']);
    expect(calls[0]?.slice(3)).toEqual(['NX', 'PX', '5000']);
    // calls[0][2] is the random secret — just assert it's a non-empty string.
    expect(calls[0]?.[2]?.length).toBeGreaterThan(0);
    expect(calls[1]).toEqual(['INCR', 'orders:42:fence']);
  });

  it('returns null when SET NX is rejected (lock already held)', async () => {
    const { runner, calls } = scriptedRunner([nilBulk]);
    const lock = new RedisLock(runner);

    const result = await lock.acquire('orders:42', { ttlMs: 5000 });

    expect(result).toBeNull();
    // INCR must not be issued when SET failed.
    expect(calls).toHaveLength(1);
  });

  it('generates a different secret value for each acquire on the same key', async () => {
    const { runner, calls } = scriptedRunner([ok, integer(1), ok, integer(2)]);
    const lock = new RedisLock(runner);

    await lock.acquire('k', { ttlMs: 1000 });
    await lock.acquire('k', { ttlMs: 1000 });

    expect(calls[0]?.[2]).not.toBe(calls[2]?.[2]);
  });

  it('fence token is a bigint (matches RESP integer width)', async () => {
    const { runner } = scriptedRunner([ok, integer(9_000_000_000)]);
    const lock = new RedisLock(runner);

    const result = await lock.acquire('k', { ttlMs: 1000 });
    expect(typeof result!.token).toBe('bigint');
    expect(result!.token).toBe(9_000_000_000n);
  });
});
