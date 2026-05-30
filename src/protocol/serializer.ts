/**
 * Encode one RESP2 bulk string ($length\r\npayload\r\n).
 *
 * Length is the byte count of the payload, not the JavaScript string length,
 * so UTF-8 multi-byte characters and binary Buffer payloads encode correctly.
 */
export function encodeBulkString(payload: string | Buffer): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([
    Buffer.from(`$${bytes.length}\r\n`),
    bytes,
    Buffer.from('\r\n'),
  ]);
}

/**
 * Encode a Redis command as a RESP array of bulk strings.
 *
 * Redis commands are always sent this way — even numeric-looking args are
 * bulk strings on the wire (e.g. SET foo 42 → "$2\r\n42\r\n", not ":42\r\n").
 */
export function serializeCommand(args: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat([
    Buffer.from(`*${args.length}\r\n`),
    ...args.map(encodeBulkString),
  ]);
}
