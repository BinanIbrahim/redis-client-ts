import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('public API surface', () => {
  it('exposes every layer through the package entry point', () => {
    // Client
    expect(typeof api.RedisClient).toBe('function');
    expect(typeof api.RedisConnection).toBe('function');
    expect(typeof api.ConnectionPool).toBe('function');
    expect(typeof api.SubscriberConnection).toBe('function');

    // Patterns
    expect(typeof api.RedisLock).toBe('function');
    expect(typeof api.TokenBucketRateLimiter).toBe('function');
    expect(typeof api.RateLimiterContentionError).toBe('function');
    expect(typeof api.Queue).toBe('function');
    expect(typeof api.QueueWorker).toBe('function');

    // Meta
    expect(typeof api.VERSION).toBe('string');
  });
});
