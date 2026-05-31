export const VERSION = '0.0.1';

// Client layer
export { RedisClient } from './client/client.js';
export { RedisConnection, type ConnectionOptions } from './client/connection.js';
export { ConnectionPool, type PoolOptions } from './client/pool.js';
export { SubscriberConnection, type MessageHandler } from './client/subscriber.js';
export type { CommandRunner } from './client/command-runner.js';

// Protocol layer (mostly internal; RespValue is exposed because the
// CommandRunner contract uses it).
export type { RespValue } from './protocol/types.js';

// Patterns
export { RedisLock, type Lock, type AcquireOptions } from './patterns/lock.js';
export {
  TokenBucketRateLimiter,
  RateLimiterContentionError,
  type TokenBucketOptions,
  type RateLimitDecision,
} from './patterns/rate-limiter.js';
export {
  Queue,
  QueueWorker,
  type QueueOptions,
  type WorkerOptions,
  type Message,
} from './patterns/queue.js';
