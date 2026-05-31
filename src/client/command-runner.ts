import type { RespValue } from '../protocol/types.js';

/**
 * The minimum surface a higher-level pattern needs from the connection layer:
 * send a command, get back the parsed RESP frame. RedisConnection already
 * satisfies this; patterns depend on this interface so they can be unit-tested
 * with a mock without TCP.
 */
export interface CommandRunner {
  sendCommand(args: readonly string[]): Promise<RespValue>;
}
