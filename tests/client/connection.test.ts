import { describe, it, expect, vi } from 'vitest';
import { MockSocket, asSocket } from './mock-socket.js';
import { RedisConnection } from '../../src/client/connection.js';

describe('RedisConnection', () => {
  it('connect resolves when the socket emits connect', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });
  });

  it('sendCommand writes a serialized RESP command to the socket', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const response = conn.sendCommand(['GET', 'mykey']);
    expect(socket.written).toHaveLength(1);
    expect(socket.written[0]?.equals(Buffer.from('*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n'))).toBe(
      true,
    );

    socket.emit('data', Buffer.from('$3\r\nfoo\r\n'));
    await expect(response).resolves.toEqual({ type: 'bulk', value: Buffer.from('foo') });
  });

  it('rejects when Redis returns an error frame', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const response = conn.sendCommand(['GET', 'missing']);
    socket.emit('data', Buffer.from('-ERR no such key\r\n'));
    await expect(response).rejects.toThrow('ERR no such key');
  });

  it('resolves only after a complete frame arrives across multiple data events', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const response = conn.sendCommand(['GET', 'k']);
    socket.emit('data', Buffer.from('$3\r\n'));
    socket.emit('data', Buffer.from('foo\r\n'));

    await expect(response).resolves.toEqual({ type: 'bulk', value: Buffer.from('foo') });
  });

  it('rejects pending commands when the socket errors', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const response = conn.sendCommand(['PING']);
    socket.emit('error', new Error('connection reset'));
    await expect(response).rejects.toThrow('connection reset');
  });

  it('disconnect ends the socket', async () => {
    const socket = new MockSocket();
    const end = vi.spyOn(socket, 'end');
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    conn.disconnect();
    expect(end).toHaveBeenCalledOnce();
  });
});
