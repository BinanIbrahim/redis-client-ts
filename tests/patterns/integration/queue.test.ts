import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisConnection } from '../../../src/client/connection.js';
import { Queue, QueueWorker } from '../../../src/patterns/queue.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

describe('integration: message queue @integration', () => {
  // Producer and consumer get their own connections so blocking BLMOVE on
  // the consumer doesn't tie up the producer.
  let producerConn: RedisConnection;
  let consumerConn: RedisConnection;
  let available = false;

  beforeAll(async () => {
    producerConn = new RedisConnection();
    consumerConn = new RedisConnection();
    try {
      await producerConn.connect(REDIS_URL);
      await consumerConn.connect(REDIS_URL);
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(() => {
    if (available) {
      producerConn.disconnect();
      consumerConn.disconnect();
    }
  });

  // Unique queue name per test so leftovers from one test never bleed into
  // another. We rely on Redis dropping the key when the list goes empty.
  let queueName: string;
  beforeEach(() => {
    queueName = `test:queue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  });

  it('preserves FIFO order across consecutive dequeues', async ({ skip }) => {
    if (!available) skip();
    const q = new Queue(producerConn, { name: queueName });
    const w = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'w1',
    });

    await q.enqueue('a');
    await q.enqueue('b');
    await q.enqueue('c');

    const m1 = await w.dequeue({ blockMs: 1000 });
    const m2 = await w.dequeue({ blockMs: 1000 });
    const m3 = await w.dequeue({ blockMs: 1000 });

    expect([m1?.payload, m2?.payload, m3?.payload]).toEqual(['a', 'b', 'c']);
    await w.ack(m1!);
    await w.ack(m2!);
    await w.ack(m3!);
  });

  it('ack removes a message — it does not reappear on subsequent dequeues', async ({
    skip,
  }) => {
    if (!available) skip();
    const q = new Queue(producerConn, { name: queueName });
    const w = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'w1',
    });

    await q.enqueue('once');
    const msg = await w.dequeue({ blockMs: 1000 });
    await w.ack(msg!);

    const drained = await w.dequeue({ blockMs: 1 });
    expect(drained).toBeNull();
  });

  it('nack within retry budget requeues the same id with attempts+1', async ({
    skip,
  }) => {
    if (!available) skip();
    const q = new Queue(producerConn, { name: queueName });
    const w = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'w1',
      maxAttempts: 5,
    });

    await q.enqueue('retry-me');
    const first = await w.dequeue({ blockMs: 1000 });
    expect(first?.attempts).toBe(0);
    await w.nack(first!);

    const second = await w.dequeue({ blockMs: 1000 });
    expect(second?.id).toBe(first?.id);
    expect(second?.payload).toBe('retry-me');
    expect(second?.attempts).toBe(1);
    await w.ack(second!);
  });

  it('routes to DLQ once attempts hits maxAttempts', async ({ skip }) => {
    if (!available) skip();
    const q = new Queue(producerConn, { name: queueName });
    const w = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'w1',
      maxAttempts: 3,
    });
    // A separate worker pointed at the DLQ list lets us drain it the same way.
    const dlqW = new QueueWorker(consumerConn, {
      name: `${queueName}:dlq`,
      consumerId: 'dlq-reader',
    });

    await q.enqueue('poison');

    // Nack three times: attempts goes 0→1, 1→2, 2→3. On the third nack
    // attempts reaches maxAttempts so the message is dead-lettered.
    for (let i = 0; i < 3; i++) {
      const msg = await w.dequeue({ blockMs: 1000 });
      expect(msg).not.toBeNull();
      await w.nack(msg!);
    }

    // Main queue is empty now.
    const fromMain = await w.dequeue({ blockMs: 1 });
    expect(fromMain).toBeNull();

    // But the DLQ has it, at attempts=3. The DLQ worker uses the same list
    // shape (queue:<name>:dlq is just queue:<dlq-reader's-name>'s main).
    // Path: queue:<dlq-reader's name> = queue:<queueName>:dlq — matches.
    const dead = await dlqW.dequeue({ blockMs: 1000 });
    expect(dead?.payload).toBe('poison');
    expect(dead?.attempts).toBe(3);
    await dlqW.ack(dead!);
  });

  it('reclaim() returns abandoned in-flight messages to the main queue', async ({
    skip,
  }) => {
    if (!available) skip();
    const q = new Queue(producerConn, { name: queueName });
    const w1 = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'stable-worker',
    });

    await q.enqueue('survives-crash');
    const taken = await w1.dequeue({ blockMs: 1000 });
    expect(taken).not.toBeNull();
    // Simulate crash: worker process dies before ack. Message stays in
    // queue:<name>:inflight:stable-worker.

    // A restarted worker with the same consumerId reclaims its in-flights.
    const w2 = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'stable-worker',
    });
    const moved = await w2.reclaim();
    expect(moved).toBe(1);

    const recovered = await w2.dequeue({ blockMs: 1000 });
    expect(recovered?.id).toBe(taken?.id);
    expect(recovered?.payload).toBe('survives-crash');
    await w2.ack(recovered!);
  });

  it('blocking dequeue returns null on timeout when the queue is empty', async ({
    skip,
  }) => {
    if (!available) skip();
    const w = new QueueWorker(consumerConn, {
      name: queueName,
      consumerId: 'w1',
    });

    const start = Date.now();
    const result = await w.dequeue({ blockMs: 1000 });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Should have actually waited at least ~1 second (BLMOVE blocks server-side).
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});
