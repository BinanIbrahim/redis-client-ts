import { RedisConnection, type ConnectionOptions } from './connection.js';

export type PoolOptions = ConnectionOptions & {
  maxConnections: number;
};

type Waiter = {
  resolve: (connection: RedisConnection) => void;
  reject: (error: Error) => void;
};

/**
 * Bounded pool of Redis TCP connections with acquire/release and backpressure.
 *
 * When all connections are checked out and the pool is at capacity, further
 * `acquire` calls wait in FIFO order until a connection is released.
 */
export class ConnectionPool {
  private readonly idle: RedisConnection[] = [];
  private readonly all: RedisConnection[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(
    private readonly options: PoolOptions,
    private readonly connectionFactory: () => RedisConnection = () => new RedisConnection(),
  ) {}

  async acquire(): Promise<RedisConnection> {
    if (this.closed) {
      return Promise.reject(new Error('pool closed'));
    }

    const reused = this.idle.pop();
    if (reused) return reused;

    if (this.all.length < this.options.maxConnections) {
      const connection = this.connectionFactory();
      await connection.connect({
        host: this.options.host,
        port: this.options.port,
      });
      this.all.push(connection);
      return connection;
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  release(connection: RedisConnection): void {
    if (this.closed) {
      connection.disconnect();
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(connection);
      return;
    }

    this.idle.push(connection);
  }

  async close(): Promise<void> {
    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(new Error('pool closed'));
    }

    for (const connection of this.all) {
      connection.disconnect();
    }
    this.all.length = 0;
    this.idle.length = 0;
  }
}
