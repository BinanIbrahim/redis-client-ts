import { describe, it, expect } from 'vitest';
import { parse } from '../../src/protocol/parser.js';
import { serializeCommand } from '../../src/protocol/serializer.js';

describe('serializeCommand', () => {
  it('encodes SET key value as a bulk-string array', () => {
    const buf = serializeCommand(['SET', 'key', 'value']);
    expect(buf.equals(Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n'))).toBe(
      true,
    );
  });

  it('encodes a single-argument command (GET)', () => {
    const buf = serializeCommand(['GET', 'mykey']);
    expect(buf.equals(Buffer.from('*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n'))).toBe(true);
  });

  it('encodes an empty argument list as *0\\r\\n', () => {
    const buf = serializeCommand([]);
    expect(buf.equals(Buffer.from('*0\r\n'))).toBe(true);
  });

  it('encodes an empty string argument as $0\\r\\n\\r\\n', () => {
    const buf = serializeCommand(['']);
    expect(buf.equals(Buffer.from('*1\r\n$0\r\n\r\n'))).toBe(true);
  });

  it('uses byte length for UTF-8, not JavaScript string length', () => {
    // "é" is one code point but two UTF-8 bytes (0xc3 0xa9).
    const buf = serializeCommand(['é']);
    expect(buf.equals(Buffer.concat([
      Buffer.from('*1\r\n$2\r\n'),
      Buffer.from('é', 'utf8'),
      Buffer.from('\r\n'),
    ]))).toBe(true);
  });

  it('encodes binary Buffer arguments without decoding', () => {
    const payload = Buffer.from([0x00, 0xff, 0x42]);
    const buf = serializeCommand([payload]);
    expect(buf.equals(Buffer.concat([Buffer.from('*1\r\n$3\r\n'), payload, Buffer.from('\r\n')]))).toBe(
      true,
    );
  });

  it('round-trips through parse: serialized command parses back as bulk array', () => {
    const buf = serializeCommand(['SET', 'key', 'value']);
    const result = parse(buf, 0);
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'array',
        value: [
          { type: 'bulk', value: Buffer.from('SET') },
          { type: 'bulk', value: Buffer.from('key') },
          { type: 'bulk', value: Buffer.from('value') },
        ],
      },
      next: buf.length,
    });
  });
});
