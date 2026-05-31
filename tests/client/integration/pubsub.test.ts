import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisClient } from '../../../src/client/client.js';
import { RedisConnection } from '../../../src/client/connection.js';
import { SubscriberConnection } from '../../../src/client/subscriber.js';

const REDIS_URL = { host: '127.0.0.1', port: 6379 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits up to `timeoutMs` for `predicate` to return true. Real pub/sub
 * delivery is async on the wire, so tests can't just `expect` synchronously
 * after publish.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('waitFor timed out');
}

describe('integration: pub/sub @integration', () => {
  let publisher: RedisClient;
  let subscriber: SubscriberConnection;
  let control: RedisConnection;
  let available = false;

  beforeAll(async () => {
    publisher = new RedisClient();
    subscriber = new SubscriberConnection();
    control = new RedisConnection();
    try {
      await publisher.connect(REDIS_URL);
      await subscriber.connect(REDIS_URL);
      await control.connect(REDIS_URL);
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(() => {
    if (available) {
      subscriber.disconnect();
      publisher.disconnect();
      control.disconnect();
    }
  });

  it('delivers a published message to a subscribed handler', async ({ skip }) => {
    if (!available) skip();
    const channel = `test:pubsub:${Date.now()}`;
    const received: Buffer[] = [];

    await subscriber.subscribe(channel, (payload) => {
      received.push(payload);
    });

    const count = await publisher.publish(channel, 'hello');
    expect(count).toBe(1);

    await waitFor(() => received.length === 1);
    expect(received[0]?.toString('utf8')).toBe('hello');

    await subscriber.unsubscribe(channel);
  });

  it('resubscribes and keeps delivering after a server-side disconnect', async ({
    skip,
  }) => {
    if (!available) skip();
    const channel = `test:pubsub-kill:${Date.now()}`;
    const received: Buffer[] = [];

    await subscriber.subscribe(channel, (payload) => {
      received.push(payload);
    });

    // CLIENT KILL TYPE pubsub forcibly closes every pub/sub connection on
    // the server. Our subscriber's socket gets `close`, then exponential
    // backoff kicks in (100ms) and the channel is re-SUBSCRIBEd.
    await control.sendCommand(['CLIENT', 'KILL', 'TYPE', 'pubsub']);

    // Give the subscriber time to reconnect + re-issue SUBSCRIBE + receive
    // the server's confirmation. 500ms is generous against initial backoff.
    await delay(500);

    const count = await publisher.publish(channel, 'after-kill');
    expect(count).toBe(1);

    await waitFor(() => received.length === 1);
    expect(received[0]?.toString('utf8')).toBe('after-kill');

    await subscriber.unsubscribe(channel);
  });
});
