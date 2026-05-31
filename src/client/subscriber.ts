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

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;

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
 * On socket close (not from an explicit disconnect()), reconnects with
 * exponential backoff up to MAX_BACKOFF_MS, then replays SUBSCRIBE for every
 * tracked channel so handlers stay live across network blips. Pending
 * subscribe/unsubscribe acks reject on close — the caller asked for a specific
 * confirmation, so silently bridging across a disconnect would lie.
 */
export class SubscriberConnection {
  private readonly reader = new RespReader();
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly pendingAcks: PendingAck[] = [];
  private socket: Socket | null = null;
  private options: ConnectionOptions | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  // Confirmations expected from replayed SUBSCRIBEs after reconnect. These
  // have no caller to resolve, so they are consumed before pendingAcks.
  private silentAcks = 0;

  constructor(private readonly socketFactory: () => Socket = () => new Socket()) {}

  connect(options: ConnectionOptions): Promise<void> {
    this.options = options;
    this.closed = false;
    return new Promise((resolve, reject) => {
      const socket = this.openSocket();
      const onConnect = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off('connect', onConnect);
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
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
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.end();
    this.socket = null;
  }

  private openSocket(): Socket {
    const socket = this.socketFactory();
    this.socket = socket;

    socket.on('connect', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.replaySubscriptions();
    });

    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });

    socket.on('error', (err: Error) => {
      this.rejectAllAcks(err);
    });

    socket.on('close', () => {
      this.rejectAllAcks(new Error('connection closed'));
      this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    });

    if (this.options) socket.connect(this.options.port, this.options.host);
    return socket;
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket();
    }, delay);
  }

  private replaySubscriptions(): void {
    if (this.handlers.size === 0 || !this.socket) return;
    for (const channel of this.handlers.keys()) {
      this.silentAcks += 1;
      this.socket.write(serializeCommand(['SUBSCRIBE', channel]));
    }
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
      if (this.silentAcks > 0) {
        this.silentAcks -= 1;
        return;
      }
      this.pendingAcks.shift()?.resolve();
    }
  }

  private rejectAllAcks(error: Error): void {
    while (this.pendingAcks.length > 0) {
      this.pendingAcks.shift()?.reject(error);
    }
  }
}
