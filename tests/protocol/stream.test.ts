import { describe, it, expect } from 'vitest';
import { RespReader } from '../../src/protocol/stream.js';

describe('RespReader', () => {
  it('returns one frame when a complete response arrives in a single chunk', () => {
    const reader = new RespReader();
    const frames = reader.push(Buffer.from('+OK\r\n'));
    expect(frames).toEqual([{ type: 'simple', value: 'OK' }]);
  });

  it('returns nothing when the chunk is incomplete, then completes on the next push', () => {
    const reader = new RespReader();
    expect(reader.push(Buffer.from('+OK'))).toEqual([]);
    expect(reader.push(Buffer.from('\r\n'))).toEqual([{ type: 'simple', value: 'OK' }]);
  });

  it('parses multiple back-to-back frames from one chunk', () => {
    const reader = new RespReader();
    const frames = reader.push(Buffer.from('+OK\r\n+PONG\r\n'));
    expect(frames).toEqual([
      { type: 'simple', value: 'OK' },
      { type: 'simple', value: 'PONG' },
    ]);
  });

  it('handles a bulk string split across three chunks', () => {
    const reader = new RespReader();
    expect(reader.push(Buffer.from('$5\r\n'))).toEqual([]);
    expect(reader.push(Buffer.from('hel'))).toEqual([]);
    expect(reader.push(Buffer.from('lo\r\n'))).toEqual([
      { type: 'bulk', value: Buffer.from('hello') },
    ]);
  });

  it('leaves a trailing partial frame in the buffer for the next push', () => {
    const reader = new RespReader();
    const frames = reader.push(Buffer.from('+OK\r\n+PON'));
    expect(frames).toEqual([{ type: 'simple', value: 'OK' }]);
    expect(reader.push(Buffer.from('G\r\n'))).toEqual([{ type: 'simple', value: 'PONG' }]);
  });

  it('returns an empty array when push receives an empty chunk', () => {
    const reader = new RespReader();
    expect(reader.push(Buffer.alloc(0))).toEqual([]);
  });

  it('bulk payloads remain valid after the reader compacts its internal buffer', () => {
    const reader = new RespReader();
    // First frame consumes prefix; second push must not invalidate the first frame's copy.
    reader.push(Buffer.from('$3\r\nfoo\r\n'));
    const [frame] = reader.push(Buffer.from('$3\r\nbar\r\n'));
    expect(frame).toEqual({ type: 'bulk', value: Buffer.from('bar') });
  });
});
