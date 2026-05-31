import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockSocket, asSocket } from './mock-socket.js';

/**
 * Variant of MockSocket whose `connect()` does NOT auto-emit `connect`. The
 * backoff test drives multiple reconnect attempts that never succeed, so we
 * must not trigger the listener that resets backoff.
 */
class SilentMockSocket extends MockSocket {
  override connect(_port: number, _host: string): this {
    return this;
  }
}
import { SubscriberConnection } from '../../src/client/subscriber.js';

function pushArray(kind: string, channel: string, third: number | string): Buffer {
  const header = `*3\r\n$${kind.length}\r\n${kind}\r\n$${channel.length}\r\n${channel}\r\n`;
  const tail =
    typeof third === 'number'
      ? `:${third}\r\n`
      : `$${Buffer.byteLength(third)}\r\n${third}\r\n`;
  return Buffer.from(header + tail);
}

/**
 * Factory that hands out a fresh MockSocket on each call (one per reconnect
 * attempt) so the test can drive multiple socket lifecycles.
 */
function socketSequence(): {
  factory: () => MockSocket;
  sockets: MockSocket[];
  last: () => MockSocket;
} {
  const sockets: MockSocket[] = [];
  return {
    factory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
    sockets,
    get last() {
      return () => sockets[sockets.length - 1]!;
    },
  };
}

describe('SubscriberConnection reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after the initial backoff (100ms) when the socket closes', async () => {
    const seq = socketSequence();
    const sub = new SubscriberConnection(() => asSocket(seq.factory()));
    await sub.connect({ host: '127.0.0.1', port: 6379 });
    expect(seq.sockets).toHaveLength(1);

    seq.sockets[0]!.emit('close');

    // Nothing reconnected yet — before the 100ms backoff elapses.
    await vi.advanceTimersByTimeAsync(99);
    expect(seq.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(seq.sockets).toHaveLength(2);
  });

  it('replays SUBSCRIBE for every tracked channel after reconnect', async () => {
    const seq = socketSequence();
    const sub = new SubscriberConnection(() => asSocket(seq.factory()));
    await sub.connect({ host: '127.0.0.1', port: 6379 });

    const ack1 = sub.subscribe('news', () => {});
    seq.sockets[0]!.emit('data', pushArray('subscribe', 'news', 1));
    await ack1;
    const ack2 = sub.subscribe('weather', () => {});
    seq.sockets[0]!.emit('data', pushArray('subscribe', 'weather', 2));
    await ack2;

    seq.sockets[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    expect(seq.sockets).toHaveLength(2);

    const replayed = seq.last().written.map((b) => b.toString('utf8'));
    expect(replayed).toContain('*2\r\n$9\r\nSUBSCRIBE\r\n$4\r\nnews\r\n');
    expect(replayed).toContain('*2\r\n$9\r\nSUBSCRIBE\r\n$7\r\nweather\r\n');
  });

  it('uses exponential backoff (100, 200, 400, ...) capped at 5000ms', async () => {
    const sockets: SilentMockSocket[] = [];
    const sub = new SubscriberConnection(() => {
      // First socket auto-emits connect so the initial connect() resolves;
      // subsequent reconnect attempts stay silent so backoff doesn't reset.
      const s = sockets.length === 0 ? new MockSocket() : new SilentMockSocket();
      sockets.push(s as SilentMockSocket);
      return asSocket(s);
    });
    const seq = { sockets, last: () => sockets[sockets.length - 1]! };
    await sub.connect({ host: '127.0.0.1', port: 6379 });

    const expected = [100, 200, 400, 800, 1600, 3200, 5000, 5000];
    let attempts = 1;

    for (const delay of expected) {
      seq.last().emit('close');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(seq.sockets).toHaveLength(attempts);
      await vi.advanceTimersByTimeAsync(1);
      attempts += 1;
      expect(seq.sockets).toHaveLength(attempts);
    }
  });

  it('resets backoff after a successful reconnect', async () => {
    const seq = socketSequence();
    const sub = new SubscriberConnection(() => asSocket(seq.factory()));
    await sub.connect({ host: '127.0.0.1', port: 6379 });

    // First close → wait 100ms → reconnect → emit connect to mark success.
    seq.sockets[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    expect(seq.sockets).toHaveLength(2);
    seq.sockets[1]!.emit('connect');

    // Second close should also wait only 100ms (backoff reset), not 200ms.
    seq.sockets[1]!.emit('close');
    await vi.advanceTimersByTimeAsync(99);
    expect(seq.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(seq.sockets).toHaveLength(3);
  });

  it('disconnect cancels a pending reconnect', async () => {
    const seq = socketSequence();
    const sub = new SubscriberConnection(() => asSocket(seq.factory()));
    await sub.connect({ host: '127.0.0.1', port: 6379 });

    seq.sockets[0]!.emit('close');
    sub.disconnect();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(seq.sockets).toHaveLength(1);
  });

  it('messages delivered after reconnect still hit registered handlers', async () => {
    const seq = socketSequence();
    const sub = new SubscriberConnection(() => asSocket(seq.factory()));
    await sub.connect({ host: '127.0.0.1', port: 6379 });

    const handler = vi.fn();
    const ack = sub.subscribe('news', handler);
    seq.sockets[0]!.emit('data', pushArray('subscribe', 'news', 1));
    await ack;

    seq.sockets[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    // Server confirms the replayed subscribe on the new socket.
    seq.last().emit('data', pushArray('subscribe', 'news', 1));
    seq.last().emit('data', pushArray('message', 'news', 'after-reconnect'));

    expect(handler).toHaveBeenCalledWith(Buffer.from('after-reconnect'));
  });
});
