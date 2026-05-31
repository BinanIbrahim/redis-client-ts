import { describe, it, expect } from 'vitest';
import { MockSocket, asSocket } from './mock-socket.js';
import { RedisConnection } from '../../src/client/connection.js';

describe('RedisConnection: pipelining', () => {
  it('writes multiple commands before any response arrives', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const first = conn.sendCommand(['GET', 'a']);
    const second = conn.sendCommand(['GET', 'b']);

    expect(socket.written).toHaveLength(2);
    expect(socket.written[0]?.equals(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\na\r\n'))).toBe(true);
    expect(socket.written[1]?.equals(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\nb\r\n'))).toBe(true);

    socket.emit('data', Buffer.from('$1\r\nA\r\n'));
    socket.emit('data', Buffer.from('$1\r\nB\r\n'));

    await expect(first).resolves.toEqual({ type: 'bulk', value: Buffer.from('A') });
    await expect(second).resolves.toEqual({ type: 'bulk', value: Buffer.from('B') });
  });

  it('resolves pipelined responses in FIFO order even if they arrive in one chunk', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const first = conn.sendCommand(['GET', 'a']);
    const second = conn.sendCommand(['GET', 'b']);
    const third = conn.sendCommand(['GET', 'c']);

    socket.emit('data', Buffer.from('$1\r\n1\r\n$1\r\n2\r\n$1\r\n3\r\n'));

    await expect(first).resolves.toEqual({ type: 'bulk', value: Buffer.from('1') });
    await expect(second).resolves.toEqual({ type: 'bulk', value: Buffer.from('2') });
    await expect(third).resolves.toEqual({ type: 'bulk', value: Buffer.from('3') });
  });

  it('rejects only the command that received an error frame', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const ok = conn.sendCommand(['GET', 'exists']);
    const bad = conn.sendCommand(['GET', 'missing']);

    socket.emit('data', Buffer.from('$2\r\nok\r\n'));
    socket.emit('data', Buffer.from('-ERR no such key\r\n'));

    await expect(ok).resolves.toEqual({ type: 'bulk', value: Buffer.from('ok') });
    await expect(bad).rejects.toThrow('ERR no such key');
  });

  it('rejects all pipelined commands when the socket errors', async () => {
    const socket = new MockSocket();
    const conn = new RedisConnection(() => asSocket(socket));
    await conn.connect({ host: '127.0.0.1', port: 6379 });

    const first = conn.sendCommand(['GET', 'a']);
    const second = conn.sendCommand(['GET', 'b']);

    socket.emit('error', new Error('connection reset'));

    await expect(first).rejects.toThrow('connection reset');
    await expect(second).rejects.toThrow('connection reset');
  });
});
