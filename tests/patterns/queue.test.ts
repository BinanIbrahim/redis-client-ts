import { describe, it, expect, vi } from 'vitest';
import { Queue, QueueWorker } from '../../src/patterns/queue.js';
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

describe('Queue.enqueue', () => {
  it('LPUSHes a JSON envelope with attempts=0 and a generated id', async () => {
    const { runner, calls } = scriptedRunner([integer(1)]);
    const q = new Queue(runner, { name: 'jobs' });

    await q.enqueue('do-the-thing');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(['LPUSH', 'queue:jobs']);
    const envelope = JSON.parse(calls[0]![2]!);
    expect(envelope.attempts).toBe(0);
    expect(envelope.payload).toBe('do-the-thing');
    expect(typeof envelope.id).toBe('string');
    expect(envelope.id.length).toBeGreaterThan(0);
  });

  it('generates a different id for each enqueue', async () => {
    const { runner, calls } = scriptedRunner([integer(1), integer(2)]);
    const q = new Queue(runner, { name: 'jobs' });

    await q.enqueue('a');
    await q.enqueue('b');

    const id1 = JSON.parse(calls[0]![2]!).id;
    const id2 = JSON.parse(calls[1]![2]!).id;
    expect(id1).not.toBe(id2);
  });
});

describe('QueueWorker.dequeue', () => {
  it('BLMOVE from main to per-consumer inflight, returns the parsed message', async () => {
    const envelope = JSON.stringify({ id: 'abc', attempts: 0, payload: 'work' });
    const { runner, calls } = scriptedRunner([bulk(envelope)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    const msg = await worker.dequeue({ blockMs: 5000 });

    expect(msg).toEqual({ id: 'abc', attempts: 0, payload: 'work' });
    // BLMOVE source dest LEFT|RIGHT LEFT|RIGHT timeoutSeconds
    expect(calls[0]).toEqual([
      'BLMOVE',
      'queue:jobs',
      'queue:jobs:inflight:worker-1',
      'RIGHT',
      'LEFT',
      '5',
    ]);
  });

  it('returns null when BLMOVE times out (empty queue)', async () => {
    const { runner } = scriptedRunner([bulk(null)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    const msg = await worker.dequeue({ blockMs: 100 });
    expect(msg).toBeNull();
  });

  it('uses BLMOVE timeout 0 (block forever) when blockMs is 0', async () => {
    const { runner, calls } = scriptedRunner([bulk(null)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    await worker.dequeue({ blockMs: 0 });
    expect(calls[0]?.[5]).toBe('0');
  });

  it('rounds sub-second blockMs up to 1 (Redis BLMOVE only accepts integer seconds in RESP2)', async () => {
    const { runner, calls } = scriptedRunner([bulk(null)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    await worker.dequeue({ blockMs: 50 });
    expect(calls[0]?.[5]).toBe('1');
  });
});

describe('QueueWorker.ack', () => {
  it('LREM removes the exact envelope from the inflight list', async () => {
    const envelope = JSON.stringify({ id: 'abc', attempts: 0, payload: 'work' });
    const { runner, calls } = scriptedRunner([bulk(envelope), integer(1)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    const msg = await worker.dequeue({ blockMs: 1000 });
    await worker.ack(msg!);

    expect(calls[1]).toEqual(['LREM', 'queue:jobs:inflight:worker-1', '1', envelope]);
  });
});

describe('QueueWorker.nack', () => {
  it('within retry budget: atomically LREM from inflight and LPUSH back to main with attempts+1', async () => {
    const envelope = JSON.stringify({ id: 'abc', attempts: 0, payload: 'work' });
    const { runner, calls } = scriptedRunner([
      bulk(envelope), // dequeue
      ok, // MULTI
      queued, // LREM
      queued, // LPUSH back to main
      array([integer(1), integer(1)]), // EXEC
    ]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
      maxAttempts: 3,
    });

    const msg = await worker.dequeue({ blockMs: 1000 });
    await worker.nack(msg!);

    expect(calls[1]).toEqual(['MULTI']);
    expect(calls[2]).toEqual(['LREM', 'queue:jobs:inflight:worker-1', '1', envelope]);
    expect(calls[3]?.slice(0, 2)).toEqual(['LPUSH', 'queue:jobs']);
    const requeued = JSON.parse(calls[3]![2]!);
    expect(requeued).toEqual({ id: 'abc', attempts: 1, payload: 'work' });
    expect(calls[4]).toEqual(['EXEC']);
  });

  it('at retry limit: LPUSHes to the DLQ instead of main', async () => {
    const envelope = JSON.stringify({ id: 'abc', attempts: 2, payload: 'work' });
    const { runner, calls } = scriptedRunner([
      bulk(envelope),
      ok,
      queued,
      queued,
      array([integer(1), integer(1)]),
    ]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
      maxAttempts: 3,
    });

    const msg = await worker.dequeue({ blockMs: 1000 });
    await worker.nack(msg!);

    // attempts becomes 3 on the next try (>= maxAttempts), so it goes to DLQ.
    expect(calls[3]?.slice(0, 2)).toEqual(['LPUSH', 'queue:jobs:dlq']);
    const dlqEnvelope = JSON.parse(calls[3]![2]!);
    expect(dlqEnvelope.attempts).toBe(3);
    expect(dlqEnvelope.payload).toBe('work');
  });
});

describe('QueueWorker.reclaim', () => {
  it('LMOVEs every inflight message back to main until the list is empty', async () => {
    const e1 = JSON.stringify({ id: 'a', attempts: 1, payload: 'x' });
    const e2 = JSON.stringify({ id: 'b', attempts: 0, payload: 'y' });
    const { runner, calls } = scriptedRunner([bulk(e1), bulk(e2), bulk(null)]);
    const worker = new QueueWorker(runner, {
      name: 'jobs',
      consumerId: 'worker-1',
    });

    const moved = await worker.reclaim();

    expect(moved).toBe(2);
    // LMOVE source dest from-end to-end — take from inflight's tail (oldest
    // dequeued = earliest enqueued), push to main's head, preserving FIFO order.
    expect(calls[0]).toEqual([
      'LMOVE',
      'queue:jobs:inflight:worker-1',
      'queue:jobs',
      'RIGHT',
      'LEFT',
    ]);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
  });
});
