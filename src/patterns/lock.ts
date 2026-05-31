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
 * Release uses WATCH/MULTI/EXEC for atomic check-and-delete (no Lua per the
 * project scope). The flow is: WATCH the lock key, GET it, compare to our
 * secret. If it doesn't match, the lock is already gone (expired or
 * re-acquired by someone else) — UNWATCH and return. If it matches, MULTI/
 * DEL/EXEC: WATCH ensures the transaction aborts if anyone modified the key
 * between GET and EXEC, so we can never DEL a key that has since been
 * re-acquired by another holder.
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
      release: () => this.release(key, secret),
    };
  }

  private async release(key: string, secret: string): Promise<void> {
    await this.runner.sendCommand(['WATCH', key]);

    const current = await this.runner.sendCommand(['GET', key]);
    const matches =
      current.type === 'bulk' &&
      current.value !== null &&
      current.value.toString('utf8') === secret;

    if (!matches) {
      // Lock isn't ours (expired or someone else holds it). Release the
      // server-side WATCH so the connection isn't left with stale state.
      await this.runner.sendCommand(['UNWATCH']);
      return;
    }

    await this.runner.sendCommand(['MULTI']);
    await this.runner.sendCommand(['DEL', key]);
    // EXEC returns the array of queued results on commit, or null (null array)
    // if WATCH was triggered. Either way release() resolves: a null EXEC means
    // someone else modified the key between our GET and EXEC, so our DEL did
    // not run — the lock is effectively gone, which is the desired post-state.
    await this.runner.sendCommand(['EXEC']);
  }
}
