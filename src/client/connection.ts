import { Socket } from 'node:net';
import { serializeCommand } from '../protocol/serializer.js';
import { RespReader } from '../protocol/stream.js';
import type { RespValue } from '../protocol/types.js';

export type ConnectionOptions = {
  host: string;
  port: number;
};

type PendingCommand = {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
};

/**
 * One TCP connection to Redis with FIFO request/response correlation.
 *
 * Multiple `sendCommand` calls may be in flight at once (pipelining): each
 * write is queued in order and matched to the next complete RESP frame.
 */
export class RedisConnection {
  private readonly reader = new RespReader();
  private readonly pending: PendingCommand[] = [];
  private socket: Socket | null = null;

  constructor(private readonly socketFactory: () => Socket = () => new Socket()) {}

  connect(options: ConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory();
      this.socket = socket;

      socket.once('connect', () => resolve());
      socket.once('error', reject);

      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });

      socket.on('error', (err: Error) => {
        this.rejectAll(err);
      });

      socket.on('close', () => {
        this.rejectAll(new Error('connection closed'));
        this.socket = null;
      });

      socket.connect(options.port, options.host);
    });
  }

  sendCommand(args: readonly string[]): Promise<RespValue> {
    if (!this.socket) {
      return Promise.reject(new Error('not connected'));
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(serializeCommand(args));
    });
  }

  disconnect(): void {
    this.socket?.end();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      const command = this.pending.shift();
      if (!command) continue;

      if (frame.type === 'error') {
        command.reject(new Error(frame.value));
      } else {
        command.resolve(frame);
      }
    }
  }

  private rejectAll(error: Error): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(error);
    }
  }
}
