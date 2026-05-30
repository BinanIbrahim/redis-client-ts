import { RedisConnection, type ConnectionOptions } from './connection.js';
import type { RespValue } from '../protocol/types.js';

function bulkToString(value: RespValue): string | null {
  if (value.type !== 'bulk') {
    throw new Error(`expected bulk string, got ${value.type}`);
  }
  return value.value === null ? null : value.value.toString('utf8');
}

function integerToNumber(value: RespValue): number {
  if (value.type !== 'integer') {
    throw new Error(`expected integer, got ${value.type}`);
  }
  return Number(value.value);
}

function expectSimpleOk(value: RespValue): void {
  if (value.type !== 'simple' || value.value !== 'OK') {
    throw new Error(`expected OK, got ${value.type}:${String(value.value)}`);
  }
}

/**
 * High-level Redis client built on a single TCP connection.
 */
export class RedisClient {
  constructor(private readonly connection: RedisConnection = new RedisConnection()) {}

  connect(options: ConnectionOptions): Promise<void> {
    return this.connection.connect(options);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  async get(key: string): Promise<string | null> {
    return bulkToString(await this.connection.sendCommand(['GET', key]));
  }

  async set(key: string, value: string): Promise<void> {
    expectSimpleOk(await this.connection.sendCommand(['SET', key, value]));
  }

  async del(key: string): Promise<number> {
    return integerToNumber(await this.connection.sendCommand(['DEL', key]));
  }

  async expire(key: string, seconds: number): Promise<number> {
    return integerToNumber(
      await this.connection.sendCommand(['EXPIRE', key, String(seconds)]),
    );
  }

  async incr(key: string): Promise<number> {
    return integerToNumber(await this.connection.sendCommand(['INCR', key]));
  }

  async hget(key: string, field: string): Promise<string | null> {
    return bulkToString(await this.connection.sendCommand(['HGET', key, field]));
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return integerToNumber(
      await this.connection.sendCommand(['HSET', key, field, value]),
    );
  }
}
