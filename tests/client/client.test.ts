import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisClient } from '../../src/client/client.js';
import type { RedisConnection } from '../../src/client/connection.js';
import type { RespValue } from '../../src/protocol/types.js';

function mockConnection() {
  return {
    sendCommand: vi.fn<(args: readonly string[]) => Promise<RespValue>>(),
    disconnect: vi.fn(),
  } satisfies Pick<RedisConnection, 'sendCommand' | 'disconnect'>;
}

describe('RedisClient', () => {
  let connection: ReturnType<typeof mockConnection>;
  let client: RedisClient;

  beforeEach(() => {
    connection = mockConnection();
    client = new RedisClient(connection as unknown as RedisConnection);
  });

  describe('get', () => {
    it('returns null for a null bulk response', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'bulk', value: null });
      await expect(client.get('missing')).resolves.toBeNull();
      expect(connection.sendCommand).toHaveBeenCalledWith(['GET', 'missing']);
    });

    it('decodes a bulk string as UTF-8', async () => {
      connection.sendCommand.mockResolvedValue({
        type: 'bulk',
        value: Buffer.from('hello'),
      });
      await expect(client.get('k')).resolves.toBe('hello');
    });
  });

  describe('set', () => {
    it('sends SET and resolves when Redis returns OK', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'simple', value: 'OK' });
      await expect(client.set('k', 'v')).resolves.toBeUndefined();
      expect(connection.sendCommand).toHaveBeenCalledWith(['SET', 'k', 'v']);
    });
  });

  describe('del', () => {
    it('returns the integer count of keys removed', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'integer', value: 1n });
      await expect(client.del('k')).resolves.toBe(1);
      expect(connection.sendCommand).toHaveBeenCalledWith(['DEL', 'k']);
    });
  });

  describe('expire', () => {
    it('returns 1 when a timeout was set', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'integer', value: 1n });
      await expect(client.expire('k', 60)).resolves.toBe(1);
      expect(connection.sendCommand).toHaveBeenCalledWith(['EXPIRE', 'k', '60']);
    });
  });

  describe('incr', () => {
    it('returns the new integer value', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'integer', value: 42n });
      await expect(client.incr('counter')).resolves.toBe(42);
      expect(connection.sendCommand).toHaveBeenCalledWith(['INCR', 'counter']);
    });
  });

  describe('hget', () => {
    it('returns null for a missing hash field', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'bulk', value: null });
      await expect(client.hget('hash', 'field')).resolves.toBeNull();
      expect(connection.sendCommand).toHaveBeenCalledWith(['HGET', 'hash', 'field']);
    });

    it('decodes the field value as UTF-8', async () => {
      connection.sendCommand.mockResolvedValue({
        type: 'bulk',
        value: Buffer.from('value'),
      });
      await expect(client.hget('hash', 'field')).resolves.toBe('value');
    });
  });

  describe('hset', () => {
    it('returns 1 when the field was created', async () => {
      connection.sendCommand.mockResolvedValue({ type: 'integer', value: 1n });
      await expect(client.hset('hash', 'field', 'value')).resolves.toBe(1);
      expect(connection.sendCommand).toHaveBeenCalledWith(['HSET', 'hash', 'field', 'value']);
    });
  });

  describe('connect / disconnect', () => {
    it('delegates connect to the underlying connection', async () => {
      const connect = vi.fn().mockResolvedValue(undefined);
      const conn = { connect, sendCommand: vi.fn(), disconnect: vi.fn() };
      const c = new RedisClient(conn as unknown as RedisConnection);
      await c.connect({ host: '127.0.0.1', port: 6379 });
      expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 6379 });
    });

    it('delegates disconnect to the underlying connection', () => {
      client.disconnect();
      expect(connection.disconnect).toHaveBeenCalledOnce();
    });
  });
});
