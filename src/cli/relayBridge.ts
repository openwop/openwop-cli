/**
 * The relay bridge runtime (openwop-app ADR 1043 D1/D5): heartbeat, token
 * rotation, outbound delivery with retries, failure acks and a delivered-id
 * set, inbound forwarding with debounced batching and typing indicators, and
 * a loop with backoff and a 30-minute receive watchdog.
 *
 * The host contract it implements is ADR 1043 D1 (host-extension routes under
 * /v1/host/openwop-app/messaging; non-normative). Clock, sleep and randomness
 * are injected so tests drive it without real time.
 */
import type { Ctx } from '../context.js';
import { HttpError, errText, errorEnvelope } from '../errors.js';
import { writeLine } from '../io.js';
import { requestJson } from '../api.js';
import type { ChannelPlugin, DeliverResult, InboundMessage } from '../channels/types.js';
import { DeliveryError } from '../channels/types.js';
import {
  computeBackoff, DeliveredSet, EchoGuard, InboundBatcher, sleep as realSleep, Watchdog, withRetries, WATCHDOG_MS,
} from '../channels/reliability.js';
import { DEVICE_TOKEN_HEADER, MESSAGING_BASE } from './relayShared.js';

/** The ADR 1043 D1 `details.reason` values a 401 carries; the relay stops on any of them. */
export const RELAY_AUTH_REASONS = ['device_token_missing', 'device_token_invalid', 'device_token_expired', 'device_revoked', 'device_token_superseded'] as const;

/**
 * Refusals that exit NON-zero (security review): the relay lost the answer to its
 * own rotation and holds a superseded token. Nothing it can do will recover, but
 * the operator must notice, so the service shows as failed rather than stopped.
 */
export const RELAY_FAILING_REASONS: ReadonlySet<string> = new Set(['device_token_superseded']);

/** The host refused the device token: stop, do not retry (ADR 1043 D5). */
export class RelayAuthError extends Error {
  constructor(readonly reason: string) {
    super(relayAuthMessage(reason));
    this.name = 'RelayAuthError';
  }
}

export function relayAuthMessage(reason: string): string {
  switch (reason) {
    case 'device_token_superseded': return 'The relay rotated its token but never saved the new one (the answer was lost), so its token was replaced. Run `openwop relay setup` again to link a new relay.';
    case 'device_token_expired': return 'The relay token expired (the device was off for 30 days or more). Run `openwop relay setup` again.';
    case 'device_revoked': return 'This relay was revoked on the server. Run `openwop relay setup` to link a new one.';
    case 'device_token_invalid': return 'The server does not recognise this relay token. Run `openwop relay setup` again.';
    default: return `The server refused the relay token (${reason}).`;
  }
}

/** Map a request failure: 401 → RelayAuthError; everything else unchanged. */
export function classifyRelayError(err: unknown): unknown {
  if (err instanceof HttpError && err.status === 401) {
    const reason = errorEnvelope(err.body).details?.reason;
    return new RelayAuthError(typeof reason === 'string' ? reason : 'device_token_invalid');
  }
  return err;
}

/** Network errors, 408, 429 and 5xx are worth retrying; other HTTP refusals are not. */
export function isTransientHttp(err: unknown): boolean {
  if (err instanceof RelayAuthError) return false;
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true;
}

/** Seconds from a 429's Retry-After, as ms (capped at 5 min). */
export function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof HttpError) || err.status !== 429) return undefined;
  const v = Number(err.headers?.get('retry-after'));
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 300) * 1000 : undefined;
}

export interface RelayCreds {
  relayId: string;
  channel: string;
  deviceToken: string;
  tokenExpiresAt?: string;
  rotateAfter?: string;
  baseUrl?: string;
  accountId?: string;
  riskAcceptedAt?: string;
  riskNoticeVersion?: number;
}

export interface Egress {
  egressId: string;
  conversationId: string;
  text: string;
  attempts?: number;
  replyToMessageId?: string;
  media?: Array<{ url: string; mimeType?: string; filename?: string }>;
  [k: string]: unknown;
}

export interface BridgeOptions {
  ctx: Ctx;
  creds: RelayCreds;
  saveCreds: (creds: RelayCreds) => void;
  deliver: (egress: Egress) => Promise<DeliverResult | void>;
  plugin?: ChannelPlugin | undefined;
  deliveredPath?: string | null;
  debounceMs?: number;
  /** In-cycle attempts per egress before a failure ack (ADR 1043 D5: 3). */
  sendAttempts?: number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  watchdogMs?: number;
  typingMs?: number;
}

export class RelayBridge {
  readonly creds: RelayCreds;
  private heartbeatIntervalMs = 30_000;
  private pollIntervalMs = 5_000;
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private readonly delivered: DeliveredSet;
  readonly echo: EchoGuard;
  readonly batcher: InboundBatcher;
  readonly watchdog: Watchdog;
  private readonly typing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly o: BridgeOptions;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A fatal stop raised outside the loop (an inbound 401, a platform logout). */
  private fatal: { stopped: 'auth' | 'platform'; reason: string; message: string } | undefined;
  private readonly wake = new AbortController();

  constructor(opts: BridgeOptions) {
    this.o = opts;
    this.creds = { ...opts.creds };
    this.now = opts.now ?? Date.now;
    this.sleepFn = opts.sleepFn ?? realSleep;
    this.delivered = new DeliveredSet(opts.deliveredPath ?? null, undefined, undefined, this.now);
    this.echo = new EchoGuard(undefined, this.now);
    this.watchdog = new Watchdog(opts.watchdogMs ?? WATCHDOG_MS, this.now);
    this.batcher = new InboundBatcher((m) => this.postInbound(m), { debounceMs: opts.debounceMs ?? 1500, now: this.now });
  }

  private headers(): Record<string, string> { return { [DEVICE_TOKEN_HEADER]: this.creds.deviceToken }; }

  private async call(path: string, init: { method?: string; body?: unknown } = {}) {
    try {
      return await requestJson(this.o.ctx, `${MESSAGING_BASE}${path}`, { ...init, auth: false, headers: this.headers() });
    } catch (err) {
      throw classifyRelayError(err);
    }
  }

  private log(line: string): void { writeLine(this.o.ctx.io.stdout, line); }
  private warn(line: string): void { writeLine(this.o.ctx.io.stderr, line); }

  /** Heartbeat; rotate the token when the host says it is due (ADR 1043 D1). */
  async heartbeat(status = 'connected'): Promise<void> {
    const res = await this.call('/device/heartbeat', { method: 'POST', body: { status } });
    this.lastHeartbeat = this.now();
    const b = res.body ?? {};
    if (Number(b.heartbeatIntervalSeconds) > 0) this.heartbeatIntervalMs = Number(b.heartbeatIntervalSeconds) * 1000;
    if (Number(b.outboundPollIntervalSeconds) > 0) this.pollIntervalMs = Number(b.outboundPollIntervalSeconds) * 1000;
    if (typeof b.tokenExpiresAt === 'string') this.creds.tokenExpiresAt = b.tokenExpiresAt;
    if (typeof b.rotateAfter === 'string') this.creds.rotateAfter = b.rotateAfter;
    if (this.creds.rotateAfter && Date.parse(this.creds.rotateAfter) <= this.now()) await this.rotate();
  }

  /** Rotate the token: save the new one BEFORE using it (the old one has a 10-minute grace). */
  async rotate(): Promise<void> {
    const res = await this.call('/device/rotate', { method: 'POST', body: {} });
    const b = res.body ?? {};
    if (typeof b.deviceToken !== 'string' || !b.deviceToken) throw new Error('rotate answered without a token');
    const next: RelayCreds = { ...this.creds, deviceToken: b.deviceToken, tokenExpiresAt: b.tokenExpiresAt, rotateAfter: b.rotateAfter };
    this.o.saveCreds(next);
    Object.assign(this.creds, next);
    this.log(`Relay token rotated (valid until ${b.tokenExpiresAt}).`);
  }

  /** One outbound pass: pull, deliver with retries, ack successes AND failures. */
  async outboundCycle(): Promise<{ delivered: number; failed: number }> {
    const out = await this.call('/device/outbound');
    const messages: Egress[] = Array.isArray(out.body?.messages) ? out.body.messages : [];
    const egressIds: string[] = [];
    const failed: Array<{ egressId: string; error: string; permanent?: boolean }> = [];
    for (const egress of messages) {
      if (this.delivered.has(egress.egressId)) { egressIds.push(egress.egressId); continue; } // ack lost earlier: ack, never resend
      try {
        const result = await withRetries(() => this.o.deliver(egress), {
          attempts: this.o.sendAttempts ?? 3,
          isTransient: (e) => !(e instanceof DeliveryError && e.permanent),
          backoff: { baseMs: 500, capMs: 5000, ...(this.o.random ? { random: this.o.random } : {}) },
          sleepFn: (ms) => this.sleepFn(ms),
        });
        this.delivered.add(egress.egressId);
        egressIds.push(egress.egressId);
        this.echo.recordSent(egress.conversationId, egress.text ?? '', result && result.platformMessageIds ? result.platformMessageIds : []);
        this.watchdog.touch();
        await this.stopTyping(egress.conversationId);
      } catch (err) {
        const permanent = err instanceof DeliveryError && err.permanent;
        failed.push({ egressId: egress.egressId, error: errText(err).slice(0, 200), ...(permanent ? { permanent: true } : {}) });
        this.warn(`delivery ${permanent ? 'refused' : 'failed'} for ${egress.egressId}: ${errText(err)}`);
      }
    }
    if (egressIds.length || failed.length) {
      await this.call('/device/ack', { method: 'POST', body: { ...(egressIds.length ? { egressIds } : {}), ...(failed.length ? { failed } : {}) } });
    }
    return { delivered: egressIds.length, failed: failed.length };
  }

  /** Heartbeat when due, then one outbound pass. */
  async cycle(): Promise<{ delivered: number; failed: number }> {
    if (this.now() - this.lastHeartbeat >= this.heartbeatIntervalMs) await this.heartbeat();
    return this.outboundCycle();
  }

  /** Inbound from the platform: echo guard, then the batcher. */
  async onInbound(m: InboundMessage): Promise<void> {
    this.watchdog.touch();
    if (this.echo.isEcho(m)) return;
    await this.batcher.push(m);
  }

  /** POST one (possibly merged) inbound with retries on 429/5xx; a 401 is fatal. */
  async postInbound(m: InboundMessage): Promise<void> {
    try {
      const res = await withRetries(() => this.call('/device/inbound', { method: 'POST', body: m }), {
        attempts: 5,
        isTransient: isTransientHttp,
        delayFor: (err, i) => retryAfterMs(err) ?? computeBackoff(i, { ...(this.o.random ? { random: this.o.random } : {}) }),
        sleepFn: (ms) => this.sleepFn(ms),
      });
      const b = res.body ?? {};
      this.log(`← [${this.creds.channel}] ${m.conversationId}: ${m.text}${b.deduped ? ' (duplicate)' : b.accepted === false ? ` (dropped: ${b.dropped ?? 'policy'})` : ''}`);
      if (b.accepted === true && !b.deduped) await this.startTyping(m.conversationId);
    } catch (err) {
      if (err instanceof RelayAuthError) { this.fail('auth', err.reason, err.message); return; }
      this.warn(`inbound forward failed: ${errText(err)}`);
    }
  }

  /** Stop the loop for good (an inbound 401, or the platform ended the session). */
  fail(stopped: 'auth' | 'platform', reason: string, message: string): void {
    if (!this.fatal) this.fatal = { stopped, reason, message };
    this.wake.abort();
  }

  private async startTyping(conversationId: string): Promise<void> {
    if (!this.o.plugin?.setTyping) return;
    try { await this.o.plugin.setTyping(conversationId, true); } catch { return; }
    const prev = this.typing.get(conversationId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => { void this.stopTyping(conversationId); }, this.o.typingMs ?? 60_000);
    t.unref?.();
    this.typing.set(conversationId, t);
  }

  private async stopTyping(conversationId: string): Promise<void> {
    const t = this.typing.get(conversationId);
    if (!t) return;
    clearTimeout(t);
    this.typing.delete(conversationId);
    try { await this.o.plugin?.setTyping?.(conversationId, false); } catch { /* best-effort */ }
  }

  /**
   * The bridge loop: cycle at the host's poll interval while healthy, back off
   * with full jitter on failure, restart receive when the watchdog fires, stop
   * on a token refusal. Resolves with why it stopped.
   */
  async run(opts: { signal?: AbortSignal; restartReceive?: () => Promise<void> } = {}): Promise<{ stopped: 'aborted' | 'auth' | 'platform'; reason?: string }> {
    let attempt = 0;
    const signal = opts.signal ? AbortSignal.any([opts.signal, this.wake.signal]) : this.wake.signal;
    while (!signal.aborted) {
      try {
        await this.cycle();
        attempt = 0;
        if (opts.restartReceive && this.watchdog.expired()) {
          this.warn(`no platform activity for ${Math.round(this.watchdog.idleMs() / 60000)} min — restarting receive`);
          this.watchdog.touch();
          await opts.restartReceive();
        }
        await this.sleepFn(this.pollIntervalMs, signal);
      } catch (err) {
        if (err instanceof RelayAuthError) { this.fail('auth', err.reason, err.message); break; }
        const ms = computeBackoff(attempt++, { ...(this.o.random ? { random: this.o.random } : {}) });
        this.warn(`bridge cycle error: ${errText(err)} — retrying in ${Math.round(ms / 1000)}s`);
        await this.sleepFn(ms, signal);
      }
    }
    for (const c of [...this.typing.keys()]) await this.stopTyping(c);
    if (this.fatal) {
      this.warn(this.fatal.message);
      return { stopped: this.fatal.stopped, reason: this.fatal.reason };
    }
    await this.batcher.flushAll().catch(() => undefined);
    return { stopped: 'aborted' };
  }
}
