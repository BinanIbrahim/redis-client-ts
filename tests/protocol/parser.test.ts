import { describe, it, expect } from 'vitest';
import { parse } from '../../src/protocol/parser.js';

describe('parse: simple strings', () => {
  it('parses +OK\\r\\n', () => {
    const buf = Buffer.from('+OK\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'simple', value: 'OK' },
      next: 5,
    });
  });

  it('parses an empty simple string +\\r\\n', () => {
    const buf = Buffer.from('+\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'simple', value: '' },
      next: 3,
    });
  });

  it('respects the start offset and stops at CRLF (does not consume trailing bytes)', () => {
    // Two frames back-to-back. Parsing the first should leave `next` pointing
    // at the start of the second, not consume into it.
    const buf = Buffer.from('+OK\r\n+PONG\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'simple', value: 'OK' },
      next: 5,
    });
    // And parsing from `next` reads the second frame correctly.
    expect(parse(buf, 5)).toEqual({
      ok: true,
      value: { type: 'simple', value: 'PONG' },
      next: 12,
    });
  });

  it('returns need: more when CRLF is missing entirely', () => {
    const buf = Buffer.from('+OK');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when only \\r has arrived (no \\n yet)', () => {
    const buf = Buffer.from('+OK\r');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when only the prefix byte has arrived', () => {
    const buf = Buffer.from('+');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });
});

describe('parse: errors', () => {
  it('parses -ERR unknown command\\r\\n', () => {
    const buf = Buffer.from('-ERR unknown command\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'error', value: 'ERR unknown command' },
      next: 22,
    });
  });

  it('parses an empty error -\\r\\n', () => {
    const buf = Buffer.from('-\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'error', value: '' },
      next: 3,
    });
  });

  it('returns need: more when CRLF is missing', () => {
    const buf = Buffer.from('-ERR oops');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when only \\r has arrived', () => {
    const buf = Buffer.from('-ERR oops\r');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });
});

describe('parse: integers', () => {
  it('parses :42\\r\\n', () => {
    const buf = Buffer.from(':42\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'integer', value: 42n },
      next: 5,
    });
  });

  it('parses :0\\r\\n', () => {
    const buf = Buffer.from(':0\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'integer', value: 0n },
      next: 4,
    });
  });

  it('parses negative integers', () => {
    const buf = Buffer.from(':-7\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'integer', value: -7n },
      next: 5,
    });
  });

  it('parses values larger than Number.MAX_SAFE_INTEGER as bigint', () => {
    // 2^53 + 1 — would lose precision as a JS number.
    const buf = Buffer.from(':9007199254740993\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'integer', value: 9007199254740993n },
      next: 19,
    });
  });

  it('returns need: more when CRLF is missing', () => {
    const buf = Buffer.from(':42');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when only \\r has arrived', () => {
    const buf = Buffer.from(':42\r');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('throws on non-numeric integer payload', () => {
    const buf = Buffer.from(':4x2\r\n');
    expect(() => parse(buf, 0)).toThrow(/malformed RESP/);
  });

  it('throws on empty integer payload', () => {
    const buf = Buffer.from(':\r\n');
    expect(() => parse(buf, 0)).toThrow(/malformed RESP/);
  });
});

describe('parse: bulk strings', () => {
  it('parses $5\\r\\nhello\\r\\n', () => {
    const buf = Buffer.from('$5\r\nhello\r\n');
    const r = parse(buf, 0);
    expect(r).toEqual({
      ok: true,
      value: { type: 'bulk', value: Buffer.from('hello') },
      next: 11,
    });
  });

  it('parses the empty bulk $0\\r\\n\\r\\n', () => {
    const buf = Buffer.from('$0\r\n\r\n');
    const r = parse(buf, 0);
    expect(r).toEqual({
      ok: true,
      value: { type: 'bulk', value: Buffer.alloc(0) },
      next: 6,
    });
  });

  it('parses the null bulk $-1\\r\\n', () => {
    const buf = Buffer.from('$-1\r\n');
    expect(parse(buf, 0)).toEqual({
      ok: true,
      value: { type: 'bulk', value: null },
      next: 5,
    });
  });

  it('is binary-safe: payload may contain CRLF', () => {
    // 7 bytes: "ab\r\ncd\r" — the embedded \r\n must NOT terminate the frame.
    // Length is read first; the parser consumes exactly 7 payload bytes.
    const payload = Buffer.from('ab\r\ncd\r');
    const buf = Buffer.concat([Buffer.from('$7\r\n'), payload, Buffer.from('\r\n')]);
    const r = parse(buf, 0);
    expect(r).toEqual({
      ok: true,
      value: { type: 'bulk', value: payload },
      next: buf.length,
    });
  });

  it('is binary-safe: payload may contain null bytes', () => {
    const payload = Buffer.from([0x00, 0xff, 0x00, 0x42]);
    const buf = Buffer.concat([Buffer.from('$4\r\n'), payload, Buffer.from('\r\n')]);
    const r = parse(buf, 0);
    expect(r).toEqual({
      ok: true,
      value: { type: 'bulk', value: payload },
      next: buf.length,
    });
  });

  it('returns need: more when length CRLF is missing', () => {
    const buf = Buffer.from('$5');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when payload is incomplete', () => {
    const buf = Buffer.from('$5\r\nhel');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when payload is complete but trailing CRLF is missing', () => {
    const buf = Buffer.from('$5\r\nhello');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('returns need: more when only \\r of the trailing CRLF has arrived', () => {
    const buf = Buffer.from('$5\r\nhello\r');
    expect(parse(buf, 0)).toEqual({ ok: false, need: 'more' });
  });

  it('throws when trailing bytes after payload are not CRLF', () => {
    // Length says 5, payload is "hello", but next bytes are "XY" instead of "\r\n".
    // This is malformed — Redis would never send this.
    const buf = Buffer.from('$5\r\nhelloXY');
    expect(() => parse(buf, 0)).toThrow(/malformed RESP/);
  });

  it('throws on negative length other than -1', () => {
    const buf = Buffer.from('$-2\r\n');
    expect(() => parse(buf, 0)).toThrow(/malformed RESP/);
  });

  it('respects offset: parses a second bulk back-to-back', () => {
    const buf = Buffer.from('$3\r\nfoo\r\n$3\r\nbar\r\n');
    const first = parse(buf, 0);
    expect(first).toEqual({
      ok: true,
      value: { type: 'bulk', value: Buffer.from('foo') },
      next: 9,
    });
    if (!first.ok) throw new Error('unreachable');
    expect(parse(buf, first.next)).toEqual({
      ok: true,
      value: { type: 'bulk', value: Buffer.from('bar') },
      next: 18,
    });
  });
});
