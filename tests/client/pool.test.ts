import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionPool } from '../../src/client/pool.js';
import type { RedisConnection } from '../../src/client/connection.js';

const POOL_OPTS = { host: '127.0.0.1', port: 6379, maxConnections: 2 };

function mockConnection(id: string): RedisConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendCommand: vi.fn(),
    _id: id,
  } as unknown as RedisConnection;
}

describe('ConnectionPool', () => {
  let created: RedisConnection[];
  let factory: () => RedisConnection;

  beforeEach(() => {
    created = [];
    let n = 0;
    factory = () => {
      const conn = mockConnection(String(++n));
      created.push(conn);
      return conn;
    };
  });

  it('creates a new connection on first acquire', async () => {
    const pool = new ConnectionPool(POOL_OPTS, factory);
    const conn = await pool.acquire();

    expect(created).toHaveLength(1);
    expect(conn.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 6379 });
    await pool.close();
  });

  it('reuses a released connection instead of creating a new one', async () => {
    const pool = new ConnectionPool(POOL_OPTS, factory);
    const first = await pool.acquire();
    pool.release(first);

    const second = await pool.acquire();
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    await pool.close();
  });

  it('creates up to maxConnections before waiting', async () => {
    const pool = new ConnectionPool(POOL_OPTS, factory);
    const a = await pool.acquire();
    const b = await pool.acquire();

    expect(created).toHaveLength(2);
    expect(a).not.toBe(b);

    let resolved = false;
    const waiting = pool.acquire().then((conn) => {
      resolved = true;
      return conn;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    pool.release(a);
    const c = await waiting;
    expect(resolved).toBe(true);
    expect(c).toBe(a);
    expect(created).toHaveLength(2);

    pool.release(b);
    pool.release(c);
    await pool.close();
  });

  it('serves waiters in FIFO order when a connection is released', async () => {
    const pool = new ConnectionPool({ ...POOL_OPTS, maxConnections: 1 }, factory);
    const only = await pool.acquire();

    const firstWait = pool.acquire();
    const secondWait = pool.acquire();

    pool.release(only);
    const gotFirst = await firstWait;
    expect(gotFirst).toBe(only);

    pool.release(gotFirst);
    const gotSecond = await secondWait;
    expect(gotSecond).toBe(only);
    expect(created).toHaveLength(1);

    pool.release(gotSecond);
    await pool.close();
  });

  it('rejects waiters when the pool is closed', async () => {
    const pool = new ConnectionPool({ ...POOL_OPTS, maxConnections: 1 }, factory);
    const conn = await pool.acquire();

    const waiting = pool.acquire();
    await pool.close();

    await expect(waiting).rejects.toThrow(/pool closed/i);
    expect(conn.disconnect).toHaveBeenCalled();
  });
});
