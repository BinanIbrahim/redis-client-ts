import { parse } from './parser.js';
import type { RespValue } from './types.js';

/**
 * Accumulates TCP chunks and extracts complete RESP frames.
 *
 * Wraps the pure `parse(buf, offset)` function with a persistent buffer.
 * On each `push`, complete frames are returned and consumed bytes are
 * discarded so the buffer does not grow without bound.
 */
export class RespReader {
  private buffer = Buffer.alloc(0);

  /**
   * Append bytes from the socket. Returns every frame that became complete
   * after this chunk arrived (may be zero, one, or many).
   */
  push(chunk: Buffer): RespValue[] {
    if (chunk.length === 0) return [];

    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: RespValue[] = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      const result = parse(this.buffer, offset);
      if (!result.ok) break;
      frames.push(result.value);
      offset = result.next;
    }

    // Drop consumed prefix. Copy so we release the old backing store — a
    // subarray would pin the entire original TCP chunk in memory.
    this.buffer =
      offset >= this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset));

    return frames;
  }
}
