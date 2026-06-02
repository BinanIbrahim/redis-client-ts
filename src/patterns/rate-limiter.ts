import type { CommandRunner } from '../client/command-runner.js';
import type { RespValue } from '../protocol/types.js';

export type TokenBucketOptions = {
  /** Maximum tokens the bucket can hold — also the maximum burst size. */
  capacity: number;
  /** Steady-state replenishment rate. */
  refillRatePerSec: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Total acquire attempts before throwing on contention. */
  maxRetries?: number;
};

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

/**
 * Thrown when WATCH/EXEC was aborted more times in a row than `maxRetries`
 * allows. In practice means another acquirer keeps winning the race on the
 * same key — usually a sign of pathological contention rather than a
 * normal rate-limit decision, so it is an exception, not a {allowed:false}.
 */
export class RateLimiterContentionError extends Error {
  constructor() {
    super('rate limiter contention exhausted retries');
    this.name = 'RateLimiterContentionError';
  }
}

const DEFAULT_MAX_RETRIES = 3;

/**
 * Token bucket rate limiter backed by a single Redis hash per key.
 *
 * State: limiter:<key> = { tokens: float-as-string, ts: ms-int-as-string }.
 * Each acquire reads the prior (tokens, ts), adds `(now - ts) * rate` tokens
 * (capped at capacity), then either consumes 1 or denies.
 *
 * Atomicity uses WATCH + MULTI/HSET/PEXPIRE/EXEC — same pattern as RedisLock.
 * No Lua per PROJECT_CONVENTIONS.md scope; the WATCH guarantees we never write tokens
 * computed from a stale read. Aborted EXECs retry up to `maxRetries` times.
 *
 * The hash key carries a PEXPIRE of (capacity / rate) seconds × 2 so idle
 * buckets eventually free themselves; an active bucket gets the TTL bumped
 * on every acquire and so never expires under traffic.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly ttlMs: number;
  // Serializes concurrent tryAcquire calls on this instance. Redis transaction
  // state (MULTI/EXEC) is per-connection, so two parallel WATCH→...→EXEC
  // sequences on the same socket collide with "ERR MULTI calls can not be
  // nested". We chain calls through a promise so only one transaction is in
  // flight at a time per limiter instance.
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runner: CommandRunner,
    opts: TokenBucketOptions,
  ) {
    this.capacity = opts.capacity;
    this.refillRatePerSec = opts.refillRatePerSec;
    this.now = opts.now ?? (() => Date.now());
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Idle TTL — long enough that a bucket that just refilled to capacity
    // doesn't expire halfway through being drained.
    this.ttlMs = Math.ceil((this.capacity / this.refillRatePerSec) * 2 * 1000);
  }

  async tryAcquire(key: string): Promise<RateLimitDecision> {
    const prior = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
      return await this.runAttempts(`limiter:${key}`);
    } finally {
      release();
    }
  }

  private async runAttempts(redisKey: string): Promise<RateLimitDecision> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const decision = await this.attempt(redisKey);
      if (decision !== 'retry') return decision;
    }
    throw new RateLimiterContentionError();
  }

  private async attempt(redisKey: string): Promise<RateLimitDecision | 'retry'> {
    await this.runner.sendCommand(['WATCH', redisKey]);

    const state = await this.runner.sendCommand([
      'HMGET',
      redisKey,
      'tokens',
      'ts',
    ]);
    const { tokens: prevTokens, ts: prevTs } = parseState(state);

    const now = this.now();
    // Cold start: treat as a full bucket as of now (first request always wins).
    let tokens =
      prevTokens === null || prevTs === null
        ? this.capacity
        : Math.min(
            this.capacity,
            prevTokens + ((now - prevTs) / 1000) * this.refillRatePerSec,
          );

    if (tokens < 1) {
      await this.runner.sendCommand(['UNWATCH']);
      const needed = 1 - tokens;
      const retryAfterMs = Math.ceil((needed / this.refillRatePerSec) * 1000);
      return { allowed: false, retryAfterMs };
    }

    tokens -= 1;

    await this.runner.sendCommand(['MULTI']);
    await this.runner.sendCommand([
      'HSET',
      redisKey,
      'tokens',
      String(tokens),
      'ts',
      String(now),
    ]);
    await this.runner.sendCommand(['PEXPIRE', redisKey, String(this.ttlMs)]);
    const execResult = await this.runner.sendCommand(['EXEC']);

    if (execResult.type === 'array' && execResult.value === null) {
      // Someone else modified the key between our WATCH and EXEC — retry.
      return 'retry';
    }

    return { allowed: true, remaining: Math.floor(tokens) };
  }
}

function parseState(value: RespValue): {
  tokens: number | null;
  ts: number | null;
} {
  if (value.type !== 'array' || value.value === null || value.value.length !== 2) {
    throw new Error(`expected 2-element array from HMGET, got ${value.type}`);
  }
  const [tokensFrame, tsFrame] = value.value;
  return {
    tokens: bulkToNumber(tokensFrame!),
    ts: bulkToNumber(tsFrame!),
  };
}

function bulkToNumber(frame: RespValue): number | null {
  if (frame.type !== 'bulk') {
    throw new Error(`expected bulk in HMGET reply, got ${frame.type}`);
  }
  if (frame.value === null) return null;
  return Number(frame.value.toString('utf8'));
}
