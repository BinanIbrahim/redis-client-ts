import { Socket } from 'node:net';
import { serializeCommand } from '../protocol/serializer.js';
import { RespReader } from '../protocol/stream.js';
import type { RespValue } from '../protocol/types.js';
import type { ConnectionOptions } from './connection.js';

export type MessageHandler = (payload: Buffer) => void;

type PendingAck = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * A connection dedicated to Redis pub/sub.
 *
 * Unlike a request/response connection, frames arrive in two distinct shapes
 * on the same socket:
 *
 *   - Confirmations: ["subscribe"|"unsubscribe", channel, count] — one per
 *     channel, in send order. They resolve the promise returned by
 *     subscribe/unsubscribe.
 *   - Server-pushed messages: ["message", channel, payload] — delivered any
 *     time, with no client request. They are dispatched to the per-channel
 *     handler.
 *
 * A Redis connection in subscribed mode rejects most other commands, so this
 * type is intentionally separate from RedisConnection rather than bolted on.
 */
export class SubscriberConnection {
  private readonly reader = new RespReader();
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly pendingAcks: PendingAck[] = [];
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
        this.rejectAllAcks(err);
      });

      socket.on('close', () => {
        this.rejectAllAcks(new Error('connection closed'));
        this.socket = null;
      });

      socket.connect(options.port, options.host);
    });
  }

  subscribe(channel: string, handler: MessageHandler): Promise<void> {
    if (!this.socket) return Promise.reject(new Error('not connected'));

    return new Promise((resolve, reject) => {
      this.handlers.set(channel, handler);
      this.pendingAcks.push({ resolve, reject });
      this.socket!.write(serializeCommand(['SUBSCRIBE', channel]));
    });
  }

  unsubscribe(channel: string): Promise<void> {
    if (!this.socket) return Promise.reject(new Error('not connected'));

    return new Promise((resolve, reject) => {
      this.pendingAcks.push({
        resolve: () => {
          this.handlers.delete(channel);
          resolve();
        },
        reject,
      });
      this.socket!.write(serializeCommand(['UNSUBSCRIBE', channel]));
    });
  }

  disconnect(): void {
    this.socket?.end();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      this.dispatchFrame(frame);
    }
  }

  private dispatchFrame(frame: RespValue): void {
    if (frame.type !== 'array' || frame.value === null || frame.value.length < 1) {
      return;
    }

    const kindFrame = frame.value[0];
    if (!kindFrame || kindFrame.type !== 'bulk' || kindFrame.value === null) return;
    const kind = kindFrame.value.toString('utf8');

    if (kind === 'message') {
      const channelFrame = frame.value[1];
      const payloadFrame = frame.value[2];
      if (
        !channelFrame ||
        channelFrame.type !== 'bulk' ||
        channelFrame.value === null ||
        !payloadFrame ||
        payloadFrame.type !== 'bulk' ||
        payloadFrame.value === null
      ) {
        return;
      }
      const handler = this.handlers.get(channelFrame.value.toString('utf8'));
      handler?.(payloadFrame.value);
      return;
    }

    if (kind === 'subscribe' || kind === 'unsubscribe') {
      this.pendingAcks.shift()?.resolve();
    }
  }

  private rejectAllAcks(error: Error): void {
    while (this.pendingAcks.length > 0) {
      this.pendingAcks.shift()?.reject(error);
    }
  }
}
