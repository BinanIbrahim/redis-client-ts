import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

/**
 * Minimal socket double for connection unit tests.
 * Records writes and lets tests emit `data` / `error` / `close` events.
 */
export class MockSocket extends EventEmitter {
  readonly written: Buffer[] = [];

  write(chunk: Buffer | string): boolean {
    this.written.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }

  destroy(): this {
    this.emit('close');
    return this;
  }

  connect(_port: number, _host: string, callback?: () => void): this {
    queueMicrotask(() => {
      this.emit('connect');
      callback?.();
    });
    return this;
  }
}

export function asSocket(mock: MockSocket): Socket {
  return mock as unknown as Socket;
}
