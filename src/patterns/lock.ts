import { randomBytes } from 'node:crypto';
import type { CommandRunner } from '../client/command-runner.js';

export type AcquireOptions = {
  ttlMs: number;
};

export type Lock = {
  /**
   * Monotonically increasing per-key counter, issued at acquire time. Caller
   * MUST forward this token to the protected resource: the resource server is
   * the one that compares incoming tokens and rejects stale writers. Without
   * cooperation from the resource, no Redis lock alone is safe against process
   * pauses longer than ttlMs (Kleppmann's argument).
   */
  token: bigint;
  release: () => Promise<void>;
};

/**
 * Single-node Redis distributed lock with fencing tokens.
 *
 * Acquire is two round trips:
 *   1. SET <key> <secret> NX PX <ttl>  — atomic claim with TTL.
 *   2. INCR <key>:fence                — issue a monotonic token.
 *
 * INCR runs only on successful claim, so fence numbers handed out grow
 * strictly in acquire order (gaps are impossible because losers don't INCR).
 *
 * Release will land in slice 2 (WATCH/MULTI/EXEC for atomic check-and-delete).
 */
export class RedisLock {
  constructor(private readonly runner: CommandRunner) {}

  async acquire(key: string, opts: AcquireOptions): Promise<Lock | null> {
    const secret = randomBytes(16).toString('hex');
    const setResult = await this.runner.sendCommand([
      'SET',
      key,
      secret,
      'NX',
      'PX',
      String(opts.ttlMs),
    ]);

    // SET NX returns simple "OK" on success, null bulk on rejection.
    if (setResult.type !== 'simple' || setResult.value !== 'OK') {
      return null;
    }

    const fenceResult = await this.runner.sendCommand(['INCR', `${key}:fence`]);
    if (fenceResult.type !== 'integer') {
      throw new Error(`expected integer from INCR, got ${fenceResult.type}`);
    }

    return {
      token: fenceResult.value,
      release: () => Promise.resolve(), // slice 2
    };
  }
}
