/**
 * The five RESP2 value types, as a discriminated union.
 *
 * Bulk strings stay as Buffer (not string) so binary payloads survive the
 * parser. The client layer decides whether to decode to UTF-8 based on the
 * command being run.
 *
 * Null bulk (`$-1\r\n`) and null array (`*-1\r\n`) are represented as the
 * corresponding variant with `value: null`, not as a separate type.
 */
export type RespValue =
  | { type: 'simple'; value: string }
  | { type: 'error'; value: string }
  | { type: 'integer'; value: bigint }
  | { type: 'bulk'; value: Buffer | null }
  | { type: 'array'; value: RespValue[] | null };

/**
 * Result of attempting to parse one RESP frame out of a buffer.
 *
 * - `ok: true`  — a complete frame was read. `next` is the offset just past
 *   the last consumed byte; the caller uses it to parse the following frame.
 * - `ok: false` — not enough bytes yet. The parser made no observable
 *   progress; the caller must not advance any offset. When more bytes arrive,
 *   the caller re-invokes `parse` from the same offset.
 *
 * Malformed input is NOT represented here — it throws. `need: 'more'` is
 * reserved strictly for "valid so far, just truncated."
 */
export type ParseResult =
  | { ok: true; value: RespValue; next: number }
  | { ok: false; need: 'more' };
