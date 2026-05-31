import { describe, it, expect, vi } from 'vitest';
import { MockSocket, asSocket } from './mock-socket.js';
import { SubscriberConnection } from '../../src/client/subscriber.js';

/**
 * Helper: build a RESP2 array frame for `["<kind>", "<channel>", <count|payload>]`.
 * `third` is either an integer (subscribe/unsubscribe confirmations) or a bulk
 * string (message payloads).
 */
function pushArray(kind: string, channel: string, third: number | string): Buffer {
  const header = `*3\r\n$${kind.length}\r\n${kind}\r\n$${channel.length}\r\n${channel}\r\n`;
  const tail =
    typeof third === 'number'
      ? `:${third}\r\n`
      : `$${Buffer.byteLength(third)}\r\n${third}\r\n`;
  return Buffer.from(header + tail);
}

async function connected(): Promise<{ socket: MockSocket; sub: SubscriberConnection }> {
  const socket = new MockSocket();
  const sub = new SubscriberConnection(() => asSocket(socket));
  await sub.connect({ host: '127.0.0.1', port: 6379 });
  return { socket, sub };
}

describe('SubscriberConnection', () => {
  it('subscribe writes the correct SUBSCRIBE bytes', async () => {
    const { socket, sub } = await connected();

    void sub.subscribe('news', () => {});
    expect(socket.written).toHaveLength(1);
    expect(
      socket.written[0]?.equals(Buffer.from('*2\r\n$9\r\nSUBSCRIBE\r\n$4\r\nnews\r\n')),
    ).toBe(true);
  });

  it('subscribe resolves on the server confirmation frame', async () => {
    const { socket, sub } = await connected();

    const pending = sub.subscribe('news', () => {});

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    socket.emit('data', pushArray('subscribe', 'news', 1));
    await expect(pending).resolves.toBeUndefined();
  });

  it('dispatches incoming message frames to the registered handler', async () => {
    const { socket, sub } = await connected();
    const handler = vi.fn();

    const pending = sub.subscribe('news', handler);
    socket.emit('data', pushArray('subscribe', 'news', 1));
    await pending;

    socket.emit('data', pushArray('message', 'news', 'hello'));
    socket.emit('data', pushArray('message', 'news', 'world'));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, Buffer.from('hello'));
    expect(handler).toHaveBeenNthCalledWith(2, Buffer.from('world'));
  });

  it('unsubscribe removes the handler and resolves on confirmation', async () => {
    const { socket, sub } = await connected();
    const handler = vi.fn();

    const subAck = sub.subscribe('news', handler);
    socket.emit('data', pushArray('subscribe', 'news', 1));
    await subAck;

    const unsubAck = sub.unsubscribe('news');
    expect(
      socket.written[1]?.equals(Buffer.from('*2\r\n$11\r\nUNSUBSCRIBE\r\n$4\r\nnews\r\n')),
    ).toBe(true);

    socket.emit('data', pushArray('unsubscribe', 'news', 0));
    await expect(unsubAck).resolves.toBeUndefined();

    socket.emit('data', pushArray('message', 'news', 'late'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-subscribing the same channel replaces the handler', async () => {
    const { socket, sub } = await connected();
    const first = vi.fn();
    const second = vi.fn();

    const ack1 = sub.subscribe('news', first);
    socket.emit('data', pushArray('subscribe', 'news', 1));
    await ack1;

    const ack2 = sub.subscribe('news', second);
    socket.emit('data', pushArray('subscribe', 'news', 1));
    await ack2;

    socket.emit('data', pushArray('message', 'news', 'hi'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(Buffer.from('hi'));
  });

  it('routes confirmations to the matching channel when subscribes are pipelined', async () => {
    const { socket, sub } = await connected();

    const a = sub.subscribe('a', () => {});
    const b = sub.subscribe('b', () => {});

    socket.emit('data', pushArray('subscribe', 'a', 1));
    socket.emit('data', pushArray('subscribe', 'b', 2));

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });
});
