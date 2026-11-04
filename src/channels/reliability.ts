/**
 * Relay reliability primitives (openwop-app ADR 1043 D5): backoff with full
 * jitter, an abortable sleep, a watchdog clock, the debounced inbound batcher,
 * the echo guard, and the persisted delivered-id set.
 *
 * These are the OpenClaw patterns the MyndHyve relay plan borrowed (reconnect
 * with backoff, a 30-minute watchdog, debounced batching). Each is pure or
 * takes its clock/timers as arguments, so the bridge's behaviour is testable
 * without a live platform.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InboundMessage } from './types.js';

// ── backoff ────────────────────────────────────────────────────────────────

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

/** Full jitter: random(0, min(cap, base × 2^attempt)). Attempt 0 is the first retry. */
export function computeBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 5 * 60 * 1000;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.floor((opts.random ?? Math.random)() * ceiling);
}

/** Sleep that resolves early (never rejects) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Retry `fn` with backoff while `isTransient(err)`; rethrows the last error. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; isTransient: (err: unknown) => boolean; backoff?: BackoffOptions; sleepFn?: (ms: number) => Promise<void>; delayFor?: (err: unknown, attempt: number) => number | undefined },
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!opts.isTransient(err) || i === opts.attempts - 1) throw err;
      const ms = opts.delayFor?.(err, i) ?? computeBackoff(i, opts.backoff);
      await (opts.sleepFn ?? sleep)(ms);
    }
  }
  throw last;
}

// ── watchdog ───────────────────────────────────────────────────────────────

export const WATCHDOG_MS = 30 * 60 * 1000;

/** Tracks the last sign of life; `expired()` once nothing happened for `timeoutMs`. */
export class Watchdog {
  private last: number;
  constructor(private readonly timeoutMs = WATCHDOG_MS, private readonly now: () => number = Date.now) { this.last = now(); }
  touch(): void { this.last = this.now(); }
  expired(): boolean { return this.now() - this.last > this.timeoutMs; }
  idleMs(): number { return this.now() - this.last; }
}

// ── debounced batching ─────────────────────────────────────────────────────

export interface BatcherOptions {
  debounceMs?: number;
  maxMessages?: number;
  maxWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

/** A message that may join a batch: a plain message, not from the device's own account. */
export function isBatchable(m: InboundMessage): boolean {
  return (m.kind === undefined || m.kind === 'message') && m.fromMe !== true;
}

/** Merge a burst into one inbound: texts joined, media concatenated, the LAST message's id. */
export function mergeBatch(batch: readonly InboundMessage[]): InboundMessage {
  if (batch.length === 1) return batch[0];
  const last = batch[batch.length - 1];
  const media = batch.flatMap((m) => m.media ?? []);
  return {
    ...last,
    text: batch.map((m) => m.text).filter((t) => t.length > 0).join('\n'),
    ...(media.length ? { media } : {}),
    channelMeta: { ...(batch[0].channelMeta ?? {}), ...(last.channelMeta ?? {}), batchedIds: batch.map((m) => m.platformMessageId) },
  };
}

/**
 * Debounced batching of inbound bursts (ADR 1043 D5). Plain messages from one
 * sender in one chat within `debounceMs` of each other go out as one; at most
 * `maxMessages` or `maxWaitMs` per batch. Anything else is sent at once, after
 * flushing that chat's pending batch so order is kept.
 */
export class InboundBatcher {
  private readonly pending = new Map<string, { msgs: InboundMessage[]; first: number; timer: unknown }>();
  private readonly o: Required<BatcherOptions>;
  constructor(private readonly flush: (m: InboundMessage) => Promise<void>, opts: BatcherOptions = {}) {
    this.o = {
      debounceMs: opts.debounceMs ?? 1500,
      maxMessages: opts.maxMessages ?? 10,
      maxWaitMs: opts.maxWaitMs ?? 10_000,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      now: opts.now ?? Date.now,
    };
  }

  private keyOf(m: InboundMessage): string { return `${m.conversationId}\u0000${m.peerId}`; }

  async push(m: InboundMessage): Promise<void> {
    const key = this.keyOf(m);
    if (this.o.debounceMs <= 0 || !isBatchable(m)) {
      await this.flushKey(key);
      await this.flush(m);
      return;
    }
    const cur = this.pending.get(key);
    if (cur) {
      this.o.clearTimer(cur.timer);
      cur.msgs.push(m);
      if (cur.msgs.length >= this.o.maxMessages || this.o.now() - cur.first >= this.o.maxWaitMs) { await this.flushKey(key); return; }
      cur.timer = this.o.setTimer(() => { void this.flushKey(key); }, this.o.debounceMs);
      return;
    }
    const entry = { msgs: [m], first: this.o.now(), timer: undefined as unknown };
    entry.timer = this.o.setTimer(() => { void this.flushKey(key); }, this.o.debounceMs);
    this.pending.set(key, entry);
  }

  async flushKey(key: string): Promise<void> {
    const cur = this.pending.get(key);
    if (!cur) return;
    this.pending.delete(key);
    this.o.clearTimer(cur.timer);
    await this.flush(mergeBatch(cur.msgs));
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.pending.keys()]) await this.flushKey(key);
  }

  size(): number { return this.pending.size; }
}

// ── echo guard ─────────────────────────────────────────────────────────────

const textHash = (chat: string, text: string): string => createHash('sha256').update(`${chat}\u0000${text}`).digest('hex');

/**
 * Remembers what the relay itself sent, so its own reply in the note-to-self
 * chat never comes back as a from-me message and loops (ADR 1043 D5): platform
 * ids where the platform returns them, else a hash of the text per chat.
 */
export class EchoGuard {
  private readonly ids = new Map<string, number>();
  private readonly texts = new Map<string, number>();
  constructor(private readonly ttlMs = 2 * 60 * 1000, private readonly now: () => number = Date.now) {}

  recordSent(chat: string, text: string, platformIds: readonly string[] = []): void {
    const until = this.now() + this.ttlMs;
    for (const id of platformIds) this.ids.set(id, until);
    if (text) this.texts.set(textHash(chat, text), until);
    this.prune();
  }

  isEcho(m: InboundMessage): boolean {
    this.prune();
    if (this.ids.has(m.platformMessageId)) return true;
    return m.fromMe === true && this.texts.has(textHash(m.conversationId, m.text));
  }

  private prune(): void {
    const t = this.now();
    for (const [k, until] of this.ids) if (until < t) this.ids.delete(k);
    for (const [k, until] of this.texts) if (until < t) this.texts.delete(k);
  }
}

// ── delivered-id set ───────────────────────────────────────────────────────

/**
 * Egress ids already delivered (ADR 1043 D1/D5), persisted 0600 so an ack lost
 * after a send is re-sent as an ack, never as a second message. 24 h, ≤ 2,000.
 */
export class DeliveredSet {
  private ids = new Map<string, number>();
  constructor(private readonly path: string | null, private readonly ttlMs = 24 * 60 * 60 * 1000, private readonly max = 2000, private readonly now: () => number = Date.now) {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') this.ids.set(k, v);
      } catch { /* corrupt → start empty */ }
    }
    this.prune();
  }

  has(id: string): boolean { return this.ids.has(id); }

  add(id: string): void {
    this.ids.set(id, this.now());
    this.prune();
    this.save();
  }

  /** Forget ids the host confirmed (acked), keeping the file small. */
  forget(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) changed = this.ids.delete(id) || changed;
    if (changed) this.save();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, at] of this.ids) if (at < cutoff) this.ids.delete(k);
    while (this.ids.size > this.max) this.ids.delete(this.ids.keys().next().value as string);
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.ids)), { encoding: 'utf8', mode: 0o600 });
      try { chmodSync(this.path, 0o600); } catch { /* best-effort on Windows */ }
    } catch { /* best-effort: the in-memory set still guards this process */ }
  }
}
