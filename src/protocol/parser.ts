import type { ParseResult } from './types.js';

const CR = 0x0d; // '\r'
const LF = 0x0a; // '\n'

/**
 * Find the next CRLF in `buf` starting at `offset`.
 * Returns the index of the '\r', or -1 if no CRLF appears before end-of-buffer.
 *
 * Uses Buffer.indexOf which is a fast native scan. We then confirm the
 * following byte is '\n' — a lone '\r' is not a frame terminator in RESP2.
 */
function findCRLF(buf: Buffer, offset: number): number {
  const cr = buf.indexOf(CR, offset);
  if (cr === -1) return -1;
  // Need at least one more byte to check for '\n'. If we have '\r' as the
  // last byte, treat that as "not found yet" — caller will return need: more.
  if (cr + 1 >= buf.length) return -1;
  if (buf[cr + 1] !== LF) {
    // A bare '\r' inside a frame would be malformed for simple/error/integer.
    // But it could legitimately appear inside a bulk string payload — those
    // are read by length, not by scanning. So findCRLF is only used in
    // contexts where bare '\r' shouldn't happen. Surface it as malformed.
    throw new Error('malformed RESP: bare \\r not followed by \\n');
  }
  return cr;
}

/**
 * Parse a CRLF-terminated text payload starting just after the prefix byte.
 * Used for simple strings ('+') and errors ('-'). The returned `value` is
 * the bytes between `offset` and the CRLF, decoded as UTF-8.
 */
function readLine(
  buf: Buffer,
  offset: number,
): { ok: true; text: string; next: number } | { ok: false; need: 'more' } {
  const cr = findCRLF(buf, offset);
  if (cr === -1) return { ok: false, need: 'more' };
  const text = buf.toString('utf8', offset, cr);
  return { ok: true, text, next: cr + 2 };
}

/**
 * Parse a CRLF-terminated decimal integer starting at `offset`.
 * Shared by `:` (integer values), `$` (bulk length), and `*` (array count).
 *
 * Throws on malformed payload (non-numeric, empty). Returns need: more on
 * truncation, same contract as `parse`.
 */
function parseInteger(
  buf: Buffer,
  offset: number,
): { ok: true; value: bigint; next: number } | { ok: false; need: 'more' } {
  const line = readLine(buf, offset);
  if (!line.ok) return line;
  if (line.text.length === 0) {
    throw new Error('malformed RESP: empty integer payload');
  }
  // BigInt() accepts an optional leading '-' and otherwise requires all
  // digits; it throws SyntaxError on anything else. We rethrow as our own
  // malformed error so callers can rely on a consistent message.
  let value: bigint;
  try {
    value = BigInt(line.text);
  } catch {
    throw new Error(`malformed RESP: not a valid integer: ${JSON.stringify(line.text)}`);
  }
  return { ok: true, value, next: line.next };
}

/**
 * Attempt to parse one RESP frame starting at `offset`.
 *
 * Pure function: does not mutate `buf` and holds no state. On `need: 'more'`
 * the caller must not advance any offset — re-invoke from the same `offset`
 * when more bytes have arrived.
 *
 * Throws on malformed input. `need: 'more'` is strictly for truncation.
 */
export function parse(buf: Buffer, offset: number): ParseResult {
  if (offset >= buf.length) return { ok: false, need: 'more' };

  const prefix = buf[offset];
  switch (prefix) {
    case 0x2b /* '+' */: {
      const r = readLine(buf, offset + 1);
      if (!r.ok) return r;
      return { ok: true, value: { type: 'simple', value: r.text }, next: r.next };
    }
    case 0x2d /* '-' */: {
      const r = readLine(buf, offset + 1);
      if (!r.ok) return r;
      return { ok: true, value: { type: 'error', value: r.text }, next: r.next };
    }
    case 0x3a /* ':' */: {
      const r = parseInteger(buf, offset + 1);
      if (!r.ok) return r;
      return { ok: true, value: { type: 'integer', value: r.value }, next: r.next };
    }
    case 0x24 /* '$' */:
    case 0x2a /* '*' */:
      throw new Error(`not implemented yet: prefix ${String.fromCharCode(prefix)}`);
    default:
      throw new Error(
        `malformed RESP: unknown prefix byte 0x${prefix?.toString(16) ?? '??'} at offset ${offset}`,
      );
  }
}
