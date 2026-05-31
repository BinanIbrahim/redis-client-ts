import { describe, it, expect, vi } from 'vitest';
import { RedisLock } from '../../src/patterns/lock.js';
import type { CommandRunner } from '../../src/client/command-runner.js';
import type { RespValue } from '../../src/protocol/types.js';

const ok: RespValue = { type: 'simple', value: 'OK' };
const queued: RespValue = { type: 'simple', value: 'QUEUED' };
const integer = (n: number): RespValue => ({ type: 'integer', value: BigInt(n) });
const bulk = (s: string | null): RespValue => ({
  type: 'bulk',
  value: s === null ? null : Buffer.from(s),
});
const nullArray: RespValue = { type: 'array', value: null };
const array = (items: RespValue[]): RespValue => ({ type: 'array', value: items });

/**
 * Acquires once with a scripted SET+INCR pair, then returns the lock and a
 * function that re-arms the same runner with new responses for release(). The
 * runner is shared so calls accumulates across acquire and release.
 */
async function acquireForRelease(
  acquireSecret: { capture: string | null },
): Promise<{
  runner: CommandRunner;
  calls: string[][];
  rearm: (next: RespValue[]) => void;
  release: () => Promise<void>;
}> {
  const queue: RespValue[] = [ok, integer(1)];
  const calls: string[][] = [];
  const runner: CommandRunner = {
    sendCommand: vi.fn((args: readonly string[]) => {
      calls.push([...args]);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected sendCommand: ${args.join(' ')}`);
      return Promise.resolve(next);
    }),
  };
  const lock = new RedisLock(runner);
  const acquired = await lock.acquire('orders:42', { ttlMs: 5000 });
  acquireSecret.capture = calls[0]?.[2] ?? null;
  if (!acquired) throw new Error('acquire returned null in setup');
  return {
    runner,
    calls,
    rearm: (next) => queue.push(...next),
    release: acquired.release,
  };
}

describe('RedisLock release', () => {
  it('happy path: WATCH, GET, MULTI, DEL, EXEC commits and resolves', async () => {
    const secretRef: { capture: string | null } = { capture: null };
    const ctx = await acquireForRelease(secretRef);
    ctx.rearm([
      ok, // WATCH
      bulk(secretRef.capture!), // GET sees our secret
      ok, // MULTI
      queued, // DEL queued
      array([bulk(secretRef.capture!), integer(1)]), // EXEC committed
    ]);

    await expect(ctx.release()).resolves.toBeUndefined();

    // Acquire was 2 calls; release adds 5. Verify the release wire shape.
    expect(ctx.calls.slice(2)).toEqual([
      ['WATCH', 'orders:42'],
      ['GET', 'orders:42'],
      ['MULTI'],
      ['DEL', 'orders:42'],
      ['EXEC'],
    ]);
  });

  it('value mismatch: GET returns a different secret, UNWATCH and resolve without DEL', async () => {
    const secretRef: { capture: string | null } = { capture: null };
    const ctx = await acquireForRelease(secretRef);
    ctx.rearm([
      ok, // WATCH
      bulk('some-other-clients-secret'), // someone else holds it
      ok, // UNWATCH
    ]);

    await expect(ctx.release()).resolves.toBeUndefined();
    expect(ctx.calls.slice(2)).toEqual([
      ['WATCH', 'orders:42'],
      ['GET', 'orders:42'],
      ['UNWATCH'],
    ]);
  });

  it('lock already expired: GET returns nil, UNWATCH and resolve without DEL', async () => {
    const secretRef: { capture: string | null } = { capture: null };
    const ctx = await acquireForRelease(secretRef);
    ctx.rearm([
      ok, // WATCH
      bulk(null), // key gone
      ok, // UNWATCH
    ]);

    await expect(ctx.release()).resolves.toBeUndefined();
    expect(ctx.calls.slice(2)).toEqual([
      ['WATCH', 'orders:42'],
      ['GET', 'orders:42'],
      ['UNWATCH'],
    ]);
  });

  it('WATCH aborted (key changed between WATCH and EXEC): EXEC nil, resolve cleanly', async () => {
    const secretRef: { capture: string | null } = { capture: null };
    const ctx = await acquireForRelease(secretRef);
    ctx.rearm([
      ok, // WATCH
      bulk(secretRef.capture!), // GET still our secret (before the racing modification)
      ok, // MULTI
      queued, // DEL queued
      nullArray, // EXEC aborted by WATCH — DEL did NOT run
    ]);

    await expect(ctx.release()).resolves.toBeUndefined();
    expect(ctx.calls.slice(2)).toEqual([
      ['WATCH', 'orders:42'],
      ['GET', 'orders:42'],
      ['MULTI'],
      ['DEL', 'orders:42'],
      ['EXEC'],
    ]);
  });
});
