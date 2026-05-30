export const VERSION = '0.0.1';

export { RedisClient } from './client/client.js';
export { RedisConnection, type ConnectionOptions } from './client/connection.js';
export { ConnectionPool, type PoolOptions } from './client/pool.js';
export type { RespValue } from './protocol/types.js';
