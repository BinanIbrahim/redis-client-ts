/**
 * Demo worker. Dequeues from the same queue the server enqueues to:
 *   - Reclaims its own previous in-flights on startup (crash recovery).
 *   - Processes each job by logging + a short sleep.
 *   - Treats payload "POISON" as a failure -> nack -> retried up to
 *     maxAttempts, then dead-lettered.
 *
 * Set WORKER_ID for a stable consumer id so reclaim() survives restarts.
 * Run several in different terminals with different WORKER_IDs to see
 * messages distributed across workers.
 *
 * Run:  npx tsx examples/worker.ts
 *       WORKER_ID=w2 npx tsx examples/worker.ts
 */
import { RedisConnection, QueueWorker, type Message } from '../src/index.js';

const REDIS = { host: '127.0.0.1', port: 6379 };
const QUEUE_NAME = process.env.QUEUE_NAME ?? 'demo-jobs';
const CONSUMER_ID = process.env.WORKER_ID ?? 'w1';
const MAX_ATTEMPTS = 3;

const conn = new RedisConnection();
await conn.connect(REDIS);

const worker = new QueueWorker(conn, {
  name: QUEUE_NAME,
  consumerId: CONSUMER_ID,
  maxAttempts: MAX_ATTEMPTS,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processMessage(msg: Message): Promise<void> {
  console.log(
    `worker[${CONSUMER_ID}]: processing id=${msg.id} attempts=${msg.attempts} payload=${JSON.stringify(msg.payload)}`,
  );
  await sleep(200);
  if (msg.payload === 'POISON') {
    throw new Error('intentional failure (POISON)');
  }
}

const reclaimed = await worker.reclaim();
if (reclaimed > 0) {
  console.log(
    `worker[${CONSUMER_ID}]: reclaimed ${reclaimed} abandoned in-flight message(s) from previous run`,
  );
}

let running = true;
async function shutdown(): Promise<void> {
  console.log(`\nworker[${CONSUMER_ID}]: shutting down`);
  running = false;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `worker[${CONSUMER_ID}]: waiting for jobs on queue "${QUEUE_NAME}" (max ${MAX_ATTEMPTS} attempts before DLQ)`,
);

while (running) {
  const msg = await worker.dequeue({ blockMs: 5000 });
  if (!msg) continue;

  try {
    await processMessage(msg);
    await worker.ack(msg);
    console.log(`worker[${CONSUMER_ID}]: ack id=${msg.id}`);
  } catch (err) {
    const nextAttempts = msg.attempts + 1;
    const dest = nextAttempts >= MAX_ATTEMPTS ? 'DLQ' : 'main queue';
    console.log(
      `worker[${CONSUMER_ID}]: nack id=${msg.id} -> ${dest} (next attempts=${nextAttempts}): ${(err as Error).message}`,
    );
    await worker.nack(msg);
  }
}

conn.disconnect();
process.exit(0);
