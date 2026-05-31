import { randomBytes } from 'node:crypto';
import type { CommandRunner } from '../client/command-runner.js';

export type QueueOptions = {
  /** Logical queue name. Real Redis keys are derived: queue:<name>, etc. */
  name: string;
};

export type WorkerOptions = QueueOptions & {
  /**
   * Identifies this worker's in-flight list. Stable IDs (hostname, pod name)
   * make reclaim() useful across restarts: a restarted worker with the same
   * ID can recover its own previous in-flights. Random per-instance IDs are
   * fine for testing but mean crash recovery requires a separate sweep.
   */
  consumerId: string;
  /**
   * Total attempts before a message is dead-lettered. A message dequeued for
   * the Nth time is at attempts = N - 1; nack at attempts >= maxAttempts - 1
   * sends it to the DLQ.
   */
  maxAttempts?: number;
};

export type Message = {
  id: string;
  attempts: number;
  payload: string;
};

const DEFAULT_MAX_ATTEMPTS = 3;

function mainKey(name: string): string {
  return `queue:${name}`;
}
function inflightKey(name: string, consumerId: string): string {
  return `queue:${name}:inflight:${consumerId}`;
}
function dlqKey(name: string): string {
  return `queue:${name}:dlq`;
}

/**
 * Producer side. Enqueues messages as JSON envelopes onto the main list.
 * Workers consume them via QueueWorker.
 */
export class Queue {
  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: QueueOptions,
  ) {}

  async enqueue(payload: string): Promise<void> {
    const envelope: Message = {
      id: randomBytes(8).toString('hex'),
      attempts: 0,
      payload,
    };
    await this.runner.sendCommand([
      'LPUSH',
      mainKey(this.opts.name),
      JSON.stringify(envelope),
    ]);
  }
}

/**
 * Consumer side. Each worker owns a per-consumer in-flight list:
 * dequeue atomically moves a message there via BLMOVE, ack removes it, and
 * nack returns it (either to the main queue with attempts+1, or to the DLQ
 * once attempts hits maxAttempts).
 *
 * The library does NOT enforce a visibility timeout — if a worker hangs, its
 * messages stay in the in-flight list until the worker calls nack or reclaim.
 * For crash recovery, a restarted worker with the same consumerId can call
 * reclaim() on startup to return its previous in-flights to the main queue.
 */
export class QueueWorker {
  private readonly maxAttempts: number;
  // Tracks the exact serialized form of each dequeued message so ack/nack
  // can LREM by byte-identical value (Redis matches list elements by string
  // equality).
  private readonly inflightEnvelopes = new Map<string, string>();

  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: WorkerOptions,
  ) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async dequeue(opts: { blockMs: number }): Promise<Message | null> {
    // BLMOVE timeout is in seconds. 0 means block forever; anything else
    // rounds up so sub-second waits still actually wait.
    const timeoutSec =
      opts.blockMs === 0 ? 0 : Math.max(1, Math.ceil(opts.blockMs / 1000));

    const result = await this.runner.sendCommand([
      'BLMOVE',
      mainKey(this.opts.name),
      inflightKey(this.opts.name, this.opts.consumerId),
      'RIGHT',
      'LEFT',
      String(timeoutSec),
    ]);

    if (result.type !== 'bulk' || result.value === null) return null;
    const raw = result.value.toString('utf8');
    const msg = JSON.parse(raw) as Message;
    this.inflightEnvelopes.set(msg.id, raw);
    return msg;
  }

  async ack(msg: Message): Promise<void> {
    const envelope = this.envelopeOf(msg);
    await this.runner.sendCommand([
      'LREM',
      inflightKey(this.opts.name, this.opts.consumerId),
      '1',
      envelope,
    ]);
    this.inflightEnvelopes.delete(msg.id);
  }

  async nack(msg: Message): Promise<void> {
    const oldEnvelope = this.envelopeOf(msg);
    const next: Message = { ...msg, attempts: msg.attempts + 1 };
    const newEnvelope = JSON.stringify(next);
    const dest =
      next.attempts >= this.maxAttempts ? dlqKey(this.opts.name) : mainKey(this.opts.name);

    // Atomic: LREM-then-LPUSH must not split, or a crash between them loses
    // the message. No WATCH needed — both operations are unconditional.
    await this.runner.sendCommand(['MULTI']);
    await this.runner.sendCommand([
      'LREM',
      inflightKey(this.opts.name, this.opts.consumerId),
      '1',
      oldEnvelope,
    ]);
    await this.runner.sendCommand(['LPUSH', dest, newEnvelope]);
    await this.runner.sendCommand(['EXEC']);

    this.inflightEnvelopes.delete(msg.id);
  }

  /**
   * Moves every message in this consumer's in-flight list back to the main
   * queue. Intended for startup recovery after a crash. Safe even when the
   * inflight list is empty (returns 0).
   */
  async reclaim(): Promise<number> {
    let moved = 0;
    for (;;) {
      const result = await this.runner.sendCommand([
        'LMOVE',
        inflightKey(this.opts.name, this.opts.consumerId),
        mainKey(this.opts.name),
        'RIGHT',
        'LEFT',
      ]);
      if (result.type !== 'bulk' || result.value === null) return moved;
      moved += 1;
    }
  }

  private envelopeOf(msg: Message): string {
    const tracked = this.inflightEnvelopes.get(msg.id);
    // Fall back to a fresh serialization if the caller hand-built the message.
    // Almost never the right path in practice; the dequeue cache makes
    // ack/nack work on the exact bytes Redis stored.
    return tracked ?? JSON.stringify(msg);
  }
}
