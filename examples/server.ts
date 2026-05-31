/**
 * Demo HTTP server. POST /jobs with JSON body { payload: string }:
 *   - Per-IP token bucket: 10 burst, 5/sec sustained.
 *   - On allow: enqueue the job, respond 202 with the message id.
 *   - On deny: respond 429 with a Retry-After header.
 *
 * Pair with examples/worker.ts to see the full produce → rate-limit → enqueue
 * → consume → ack/nack → DLQ loop.
 *
 * Run:  npx tsx examples/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  RedisConnection,
  Queue,
  TokenBucketRateLimiter,
  RateLimiterContentionError,
} from '../src/index.js';

const REDIS = { host: '127.0.0.1', port: 6379 };
const PORT = Number(process.env.PORT ?? 3000);
const QUEUE_NAME = process.env.QUEUE_NAME ?? 'demo-jobs';

const conn = new RedisConnection();
await conn.connect(REDIS);

const queue = new Queue(conn, { name: QUEUE_NAME });
const limiter = new TokenBucketRateLimiter(conn, {
  capacity: 10,
  refillRatePerSec: 5,
});

function clientKey(req: IncomingMessage): string {
  // X-Forwarded-For first (when behind a proxy), else the socket peer.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/jobs') {
    send(res, 404, { error: 'not found' });
    return;
  }

  const ip = clientKey(req);
  try {
    const decision = await limiter.tryAcquire(ip);
    if (!decision.allowed) {
      send(
        res,
        429,
        { error: 'rate limited', retryAfterMs: decision.retryAfterMs },
        { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) },
      );
      return;
    }

    const body = (await readJsonBody(req)) as { payload?: unknown } | null;
    const payload = typeof body?.payload === 'string' ? body.payload : '';
    if (!payload) {
      send(res, 400, { error: 'body must be {"payload": "<string>"}' });
      return;
    }

    await queue.enqueue(payload);
    send(res, 202, { status: 'enqueued', remaining: decision.remaining });
  } catch (err) {
    if (err instanceof RateLimiterContentionError) {
      send(res, 503, { error: 'try again' });
      return;
    }
    console.error('handler error', err);
    send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(`server: listening on http://127.0.0.1:${PORT}`);
  console.log(`server: rate limit per-IP = 10 burst, 5/sec sustained`);
  console.log(`server: queue name        = ${QUEUE_NAME}`);
});

async function shutdown(): Promise<void> {
  console.log('\nserver: shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  conn.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
