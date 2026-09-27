import type { Ctx } from './context.js';
/** Run-event streaming + REPL rendering — SSE with JSON-poll fallback. */

import { createInterface } from 'node:readline';
import { requestJson } from './api.js';
import { CliError, HttpError, httpErrorLine } from './errors.js';
import { TERMINAL_STATUSES } from './constants.js';
import { negotiateMajor, resolveStreamRequest } from './protocol.js';
import { sleep } from './util.js';
import { canonicalEventType, isTerminalRunEvent } from './eventTypes.js';
import { idempotencyHeaders } from './wire.js';

/** Create a run and return its runId (throws if the response omits one). */
export async function submitTurn(ctx: Ctx, { workflowId, inputs, tenantId, scopeId }: any): Promise<string> {
  const body = {
    workflowId,
    ...(tenantId ? { tenantId } : {}),
    ...(scopeId ? { scopeId } : {}),
    inputs: inputs ?? {},
  };
  // A fresh Idempotency-Key per turn (runs.md §Create — RECOMMENDED): a
  // transport-level retry of this POST can never start the turn twice.
  const res = await requestJson(ctx, '/v1/runs', { method: 'POST', body, headers: idempotencyHeaders() });
  if (!res.body || typeof res.body.runId !== 'string') {
    throw new CliError('Run create response did not include a runId');
  }
  return res.body.runId;
}

/**
 * `streamMode` (v2 events.md §Stream modes; v1 stream-modes.md §Mode selection
 * + §Mixed mode): `values` alone, or a comma-separated combination of
 * `updates` / `messages` / `debug`. v2 states this as the query parameter's
 * pattern; v1's openapi pattern is looser but its prose forbids `values` in a
 * combination, so the one pattern serves both majors.
 */
export const STREAM_MODE_PATTERN = /^(values|(updates|messages|debug)(,(updates|messages|debug))*)$/;
export const STREAM_MODES = ['updates', 'values', 'messages', 'debug'] as const;

/** Frame names that are not run-event types (v2 events.md §SSE frames): their `data:` is not a RunEventDoc. */
const NON_EVENT_FRAMES = new Set(['state.snapshot', 'ai.message.chunk']);

/**
 * Validate the `--since` / `--last-event-id` / `--stream-mode` flags of a
 * streaming run command into StreamRunEventsOptions. Both majors resume SSE
 * with the `Last-Event-ID` header (v2 events.md §Resuming, headers.md; v1
 * stream-modes.md §Resumption, rest-endpoints.md §SSE) — neither defines a
 * `since` query parameter on the stream. v2 makes the id a sequence (a
 * non-integer SHOULD be refused `400 validation_error`), so it is checked
 * here; a v1 id is opaque and sent verbatim.
 */
export async function parseStreamStart(ctx: Ctx, options: { since?: unknown; lastEventId?: unknown; streamMode?: unknown }): Promise<Pick<StreamRunEventsOptions, 'afterSequence' | 'lastEventId' | 'streamMode'>> {
  const out: Pick<StreamRunEventsOptions, 'afterSequence' | 'lastEventId' | 'streamMode'> = {};
  if (options.since !== undefined && options.lastEventId !== undefined) throw new CliError('--since and --last-event-id are the same cursor; pass one');
  if (options.since !== undefined) {
    const v = String(options.since);
    if (!/^\d+$/.test(v)) throw new CliError(`--since must be a non-negative integer sequence (got '${v}')`);
    out.afterSequence = Number(v);
  }
  if (options.lastEventId !== undefined) {
    const v = String(options.lastEventId);
    if (v === '') throw new CliError('--last-event-id must not be empty');
    if ((await negotiateMajor(ctx)) === 2 && !/^\d+$/.test(v)) {
      throw new CliError(`--last-event-id must be a non-negative integer under protocol v2 (an SSE id is the event's sequence; got '${v}')`);
    }
    out.lastEventId = v;
  }
  if (options.streamMode !== undefined) {
    const v = String(options.streamMode);
    if (!STREAM_MODE_PATTERN.test(v)) {
      throw new CliError(`--stream-mode must be one of ${STREAM_MODES.join(' | ')}, or a comma list of updates/messages/debug ('values' never combines); got '${v}'`);
    }
    out.streamMode = v;
  }
  return out;
}

export interface StreamRunEventsOptions {
  onEvent?: (e: any) => void;
  useStream?: boolean;
  /** Poll-fallback budget (ms). */
  timeoutMs?: number;
  /** Start after this sequence (exclusive) — sent as `Last-Event-ID` on SSE, the poll cursor on the fallback. */
  afterSequence?: number;
  /** Start after this raw SSE id (sent verbatim as `Last-Event-ID`). */
  lastEventId?: string;
  /** `?streamMode=` (validated against STREAM_MODE_PATTERN by the caller). */
  streamMode?: string;
  /** Reconnect attempts after a drop without progress (default 5). */
  maxReconnects?: number;
  /** Reconnection delay before any `retry:` field is seen (default 1000 ms; WHATWG leaves it implementation-defined). */
  retryMs?: number;
  /** Abort + resume a connection that delivers no bytes for this long (default 45000; 0 disables). */
  idleTimeoutMs?: number;
  /** Give up on a connection whose response headers have not arrived in this long (default min(idle, 10000)). */
  headersTimeoutMs?: number;
  /** Called once per reconnect, before the request (for `--verbose` / tests). */
  onReconnect?: (info: { attempt: number; lastEventId: string | undefined; delayMs: number }) => void;
}

/**
 * Stream a run's events. Prefers SSE; on any failure to OPEN the SSE stream
 * (non-streamable body, non-2xx, or transport error) falls back to the JSON
 * poll endpoint. Once the stream has opened, a drop is resumed on SSE with
 * `Last-Event-ID` (see `streamViaSse`). Calls `onEvent(eventRecord)` once per
 * event in sequence order — never twice for one sequence — and resolves when
 * a terminal event is seen or the host reports the run terminal.
 */
export async function streamRunEvents(ctx: Ctx, runId: string, opts: StreamRunEventsOptions = {}) {
  const { useStream = true, timeoutMs = 120000 } = opts;
  const deliver = dedupingSink(opts.onEvent ?? (() => {}), startSequence(opts));
  if (useStream) {
    try {
      const handled = await streamViaSse(ctx, runId, deliver, opts);
      if (handled) return;
    } catch (err) {
      // A 4xx the caller asked for (an unsupported streamMode, a refused
      // Last-Event-ID) is an answer, not a transport gap: polling would
      // silently drop the mode, so surface it.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && (opts.streamMode || opts.lastEventId !== undefined || opts.afterSequence !== undefined)) throw err;
      if (err instanceof SseResumeExhausted) throw err.reason instanceof HttpError ? err.reason : err;
      if (err instanceof StreamSilent && err.beforeHeaders && !ctx.quiet) {
        ctx.io.stderr.write(`openwop: the event stream sent nothing for ${err.ms >= 1000 ? `${Math.round(err.ms / 1000)} s` : `${err.ms} ms`} — the host's front door may be buffering streams. Following by polling instead; for live events pass --stream-base-url <a direct origin> (see \`openwop doctor\`).\n`);
      }
      // Fall through to polling.
    }
  }
  if (opts.streamMode && opts.streamMode !== 'updates' && !ctx.quiet) {
    ctx.io.stderr.write(`openwop: warning: SSE unavailable; the poll fallback has no streamMode, so '${opts.streamMode}' is not applied\n`);
  }
  await streamViaPoll(ctx, runId, deliver, timeoutMs, deliver.highest());
}

/** The stream could not be resumed (exit 1); `cause` is the last HTTP refusal, when there was one. */
class SseResumeExhausted extends CliError {
  readonly reason: unknown;
  constructor(message: string, reason?: unknown) { super(message, 1); this.reason = reason; }
}

function startSequence(opts: StreamRunEventsOptions): number {
  if (typeof opts.afterSequence === 'number') return opts.afterSequence;
  if (opts.lastEventId !== undefined && /^\d+$/.test(opts.lastEventId)) return Number(opts.lastEventId);
  return -1;
}

/**
 * Wrap onEvent so a sequence is delivered at most once, in increasing order.
 * A resumed stream (or the poll fallback after a partial stream) can repeat
 * the resumption point on a host that treats `Last-Event-ID` inclusively; the
 * spec forbids that (events.md §Resuming — "MUST NOT re-emit `N`"), but the
 * client does not rely on it. Records without a numeric `sequence` (a
 * `state.snapshot`, which `values` resumption MUST re-emit first) pass through.
 */
function dedupingSink(onEvent: (e: any) => void, start: number) {
  let highest = start;
  const sink = (ev: any) => {
    const seq = typeof ev?.sequence === 'number' ? ev.sequence : undefined;
    if (seq !== undefined) {
      if (seq <= highest) return false;
      highest = seq;
    }
    onEvent(ev);
    return true;
  };
  sink.highest = () => highest;
  return sink as typeof sink & { highest: () => number };
}

/**
 * SSE with resume. The first request failing (non-2xx, non-SSE body, throw)
 * propagates so the caller can fall back to polling. After the stream opens:
 *
 *  - every frame's `id:` is remembered (WHATWG "last event ID buffer"), and a
 *    `retry:` field sets the reconnection delay;
 *  - when the connection drops or closes before a terminal run event, the CLI
 *    reconnects with `Last-Event-ID: <last id>` (events.md §Resuming; v1
 *    stream-modes.md §Resumption) after `retry` ms, doubling per consecutive
 *    attempt without progress (cap 30 s), at most `maxReconnects` times;
 *  - a close without a terminal event is checked against the run's status
 *    first: the host MUST close after the terminal event (events.md §SSE
 *    frames) and a mode such as `messages` never carries it, so a terminal
 *    status ends the stream instead of reconnecting.
 */
async function streamViaSse(ctx: Ctx, runId: string, deliver: ReturnType<typeof dedupingSink>, opts: StreamRunEventsOptions) {
  const maxReconnects = opts.maxReconnects ?? 5;
  let retryMs = opts.retryMs ?? 1000;
  let lastEventId: string | undefined = opts.lastEventId ?? (typeof opts.afterSequence === 'number' ? String(opts.afterSequence) : undefined);
  let terminal = false;
  let failures = 0;
  let opened = false;
  const query = opts.streamMode ? `?streamMode=${encodeURIComponent(opts.streamMode)}` : '';

  for (;;) {
    let progressed = false;
    let dropError: unknown;
    // Armed before fetch (so a front door that never sends headers is also
    // abandoned), and stopped on EVERY exit of this attempt — an armed timer
    // would hold the process open for up to its full span after a failure.
    let idle: ReturnType<typeof idleWatchdog> | undefined;
    try {
      // Same negotiation as requestJson (src/protocol.ts): under major 2 this is
      // `/runs/{runId}/events` + `OpenWOP-Version: 2.0`. Joined relative to the
      // base for the same reason api.ts does — a base with a path prefix survives.
      // Built by the one stream seam (src/protocol.ts resolveStreamRequest):
      // same negotiation as requestJson, joined to the stream origin.
      const { url, headers } = await resolveStreamRequest(ctx, `/v1/runs/${encodeURIComponent(runId)}/events${query}`, {});
      if (lastEventId !== undefined && lastEventId !== '') headers['last-event-id'] = lastEventId;
      // Idle watchdog: a half-open connection (no FIN, no bytes) would block
      // the reader forever and resume would never fire. ANY bytes — keep-alive
      // comments included — reset it; on expiry the request is aborted and the
      // drop is resumed with Last-Event-ID like any other.
      const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      idle = idleWatchdog(idleMs, opts.headersTimeoutMs ?? (idleMs > 0 ? Math.min(idleMs, DEFAULT_HEADERS_TIMEOUT_MS) : 0));
      const res = await ctx.fetchImpl(url, { method: 'GET', headers, signal: idle.signal });
      idle.headersArrived();
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        throw new HttpError(httpErrorLine(res.status, body), res.status, body, res.headers);
      }
      const ct = res.headers?.get?.('content-type') ?? '';
      if (!ct.includes('text/event-stream') || !res.body || typeof res.body.getReader !== 'function') {
        // Server answered with JSON (or a non-streamable body) — let the
        // caller fall back to polling rather than mis-parsing.
        if (!opened) return false;
        throw new HttpError('resumed events stream is not text/event-stream', res.status, null, res.headers);
      }
      opened = true;
      await consumeSse(idle.watch(res.body), (frame: any) => {
        if (frame.retry !== undefined) retryMs = frame.retry;
        if (frame.id !== undefined) lastEventId = frame.id;
        if (frame.data === undefined) return;
        const ev = safeParseJson(frame.data);
        const frameSeq = frame.id !== undefined && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined;
        const records: any[] = frame.event === 'batch' && Array.isArray(ev) ? ev
          : frame.event !== undefined && NON_EVENT_FRAMES.has(frame.event)
            // `ai.message.chunk` data is the outputChunk payload (sequenced by
            // the frame id); `state.snapshot` data is a RunSnapshot (not a log
            // event — no sequence, never deduped).
            ? [{ type: frame.event, ...(frame.event === 'ai.message.chunk' && frameSeq !== undefined ? { sequence: frameSeq } : {}), payload: ev }]
            : ev && typeof ev === 'object' ? [ev] : [];
        for (const one of records) {
          if (deliver(one)) progressed = true;
          if (isTerminalRunEvent(one)) terminal = true;
        }
      }, (control: { id?: string; retry?: number }) => {
        if (control.retry !== undefined) retryMs = control.retry;
        if (control.id !== undefined) lastEventId = control.id;
      });
    } catch (err) {
      if (!opened) throw err;
      // A refusal on a resume (other than rate limiting / unavailability) is final.
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw new SseResumeExhausted(err.message, err);
      dropError = err;
    } finally {
      idle?.stop();
    }
    if (terminal) return true;
    if (lastEventId === undefined && deliver.highest() >= 0) lastEventId = String(deliver.highest());
    if (await runIsTerminal(ctx, runId)) return true;
    failures = progressed ? 1 : failures + 1;
    if (failures > maxReconnects) {
      throw new SseResumeExhausted(`events stream for ${runId} dropped ${failures} times without progress${dropError instanceof Error ? `: ${dropError.message}` : ''}. Re-run with --since <last sequence printed> to continue, or --no-stream to follow by polling.`, dropError);
    }
    const delayMs = Math.min(retryMs * 2 ** (failures - 1), 30000);
    opts.onReconnect?.({ attempt: failures, lastEventId, delayMs });
    if (ctx.verbose) {
      const why = dropError instanceof StreamSilent ? `stalled (${dropError.message})` : 'dropped';
      ctx.io.stderr.write(`openwop: events stream ${why}; reconnecting in ${delayMs}ms with Last-Event-ID ${lastEventId ?? '(none)'}\n`);
    }
    await sleep(delayMs);
  }
}

/** Whether the run's status is terminal; false when the status cannot be read (keep resuming). */
async function runIsTerminal(ctx: Ctx, runId: string): Promise<boolean> {
  try {
    const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(runId)}`);
    const status = res.body?.status ?? res.body?.run?.status;
    return typeof status === 'string' && TERMINAL_STATUSES.has(status);
  } catch {
    return false;
  }
}

/**
 * Decode a web ReadableStream of SSE bytes into frames. Exported for tests so
 * the line-buffering / multi-line `data:` accumulation can be exercised
 * without a live socket. `onFrame` receives `{ event, data, id, retry }` for a
 * block carrying `data:` or `event:`; a block carrying only `id:` / `retry:`
 * (no event dispatched, per the WHATWG event-stream interpretation) goes to
 * the optional `onControl`. Comment lines (`:keepalive`) are skipped.
 */
export async function consumeSse(stream: any, onFrame: any, onControl?: (c: { id?: string; retry?: number }) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushFrame = (block: string) => {
    if (!block.trim()) return;
    const frame: { event?: string; data?: string; id?: string; retry?: number } = {};
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '' || line.startsWith(':')) continue; // blank or comment/heartbeat
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') frame.event = value;
      else if (field === 'id') { if (!value.includes('\0')) frame.id = value; }
      else if (field === 'retry') { if (/^\d+$/.test(value)) frame.retry = Number(value); }
    }
    if (dataLines.length > 0) frame.data = dataLines.join('\n');
    if (frame.data !== undefined || frame.event !== undefined) onFrame(frame);
    else if ((frame.id !== undefined || frame.retry !== undefined) && onControl) onControl(frame);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      flushFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
    if (done) {
      // WHATWG: an incomplete final block (no terminating blank line) is discarded.
      break;
    }
  }
}

async function streamViaPoll(ctx: Ctx, runId: string, onEvent: any, timeoutMs: number, after = -1) {
  const started = Date.now();
  const cursorParam = await pollCursorParam(ctx);
  let lastSequence = after;
  while (Date.now() - started < timeoutMs) {
    const query = lastSequence >= 0 ? `?${cursorParam}=${lastSequence}` : '';
    const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(runId)}/events/poll${query}`);
    const events = Array.isArray(res.body?.events) ? res.body.events : [];
    for (const ev of events) {
      onEvent(ev);
      if (typeof ev.sequence === 'number' && ev.sequence > lastSequence) lastSequence = ev.sequence;
    }
    if (pollIsTerminal(res.body) || events.some(isTerminalRunEvent)) return;
    await sleep(250);
  }
  throw new CliError(`Timed out streaming run ${runId} after ${timeoutMs}ms`, 1);
}

/**
 * The poll cursor's query-parameter name for the negotiated major. v2
 * `pollRunEvents` takes `afterSequence` ("`lastSequence` and `since` are not
 * parameters" — events.md §Poll); v1 takes `lastSequence`. Both are exclusive
 * (`sequence > N`). A v2 host ignores the v1 name and replays from 0, which is
 * why sending the wrong one is silent rather than an error.
 */
export async function pollCursorParam(ctx: Ctx): Promise<'afterSequence' | 'lastSequence'> {
  return (await negotiateMajor(ctx)) === 2 ? 'afterSequence' : 'lastSequence';
}

/** Terminal flag of a poll response: v2 `isTerminal` (events.md §Poll), v1 `isComplete`. */
export function pollIsTerminal(body: any): boolean {
  return body?.isTerminal === true || body?.isComplete === true;
}

/**
 * Pretty-print one event record for the REPL. Returns null for events that
 * carry no useful surface (so the loop can skip them). Exported for tests.
 */
export function renderEvent(ev: any): string | null {
  if (!ev || typeof ev !== 'object') return null;
  // Fold v1 names onto their v2 twins (src/eventTypes.ts) so one switch serves
  // both majors and an era-2 log read under v2.
  const type = canonicalEventType(ev.type ?? 'event');
  const node = ev.nodeId ? ` ${ev.nodeId}` : '';
  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  switch (type) {
    case 'run.started':
      return '· run started';
    case 'node.started':
      return `·${node} running`;
    case 'node.completed': {
      const reply = extractAssistantText(ev);
      return reply ? `assistant> ${reply}` : `·${node} done`;
    }
    case 'run.completed': {
      const reply = extractAssistantText(ev);
      return reply ? `assistant> ${reply}` : '· run completed';
    }
    case 'node.failed':
    case 'run.failed': {
      const msg = errorMessageOf(ev);
      return `! ${type}${node}${msg ? `: ${msg}` : ''}`;
    }
    case 'run.cancelled':
      return '· run cancelled';
    case 'run.paused':
      return '· run paused';
    case 'run.resume-started':
      return '· run resuming';
    case 'run.resumed':
      return '· run resumed';
    case 'run.dead-lettered':
      return '! run dead-lettered';
    case 'interrupt.requested':
      return `?${node} waiting${typeof payload.kind === 'string' ? ` for ${payload.kind}` : ''}`;
    case 'interrupt.resolved':
      return `·${node} interrupt resolved`;
    case 'agent.tool-called':
      return `·${node} tool ${typeof payload.toolName === 'string' ? payload.toolName : '?'} called`;
    case 'agent.tool-returned':
      return `·${node} tool ${typeof payload.toolName === 'string' ? payload.toolName : '?'} returned${payload.status === 'error' || payload.error ? ' (error)' : ''}`;
    default:
      return `· ${type}`;
  }
}

/**
 * Pull assistant-visible text out of an event payload. Handles the common
 * shapes the sample chat node emits: a `messages` array, an `output`/`result`
 * string, or a nested `content` field. Exported for tests.
 */
export function extractAssistantText(ev: any): string | null {
  const payload = ev && typeof ev === 'object' ? ev.payload : undefined;
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.output, payload.result, payload.text, payload.content, payload.message];
  for (const c of candidates) {
    const t = coerceText(c);
    if (t) return t;
  }
  if (payload.outputs && typeof payload.outputs === 'object') {
    for (const v of Object.values(payload.outputs)) {
      const t = coerceText(v);
      if (t) return t;
    }
  }
  if (Array.isArray(payload.messages)) {
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const m = payload.messages[i];
      if (m && m.role === 'assistant') {
        const t = coerceText(m.content);
        if (t) return t;
      }
    }
  }
  return null;
}

function coerceText(value: any): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value)) {
      const joined = value.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
      return joined.length > 0 ? joined : null;
    }
  }
  return null;
}

function errorMessageOf(ev: any): string {
  const payload = ev && typeof ev === 'object' ? ev.payload : undefined;
  if (payload && typeof payload === 'object') {
    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
      return payload.error.message;
    }
    if (typeof payload.message === 'string') return payload.message;
  }
  return '';
}

function safeParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Default stdin line reader for the REPL. Resolves with each line, or null on
 * EOF (Ctrl-D). Uses readline so piped input and TTY input both work.
 */
export function defaultReadTurn(ctx: Ctx): (prompt: string) => Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let closed = false;
  rl.on('close', () => { closed = true; });
  return (prompt: string) => new Promise((resolve) => {
    if (closed) { resolve(null); return; }
    if (!ctx.json) ctx.io.stdout.write(prompt);
    const onLine = (line: string) => { rl.removeListener('close', onClose); resolve(line); };
    const onClose = () => { rl.removeListener('line', onLine); resolve(null); };
    rl.once('line', onLine);
    rl.once('close', onClose);
  });
}

/**
 * ~3× the reference host's measured 15 s keep-alive interval: long enough never
 * to fire on a healthy idle run, short enough that a stalled connection resumes.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 45000;

/**
 * How long to wait for the RESPONSE HEADERS of an events stream. A host sends
 * them immediately even when no event is pending; a front door that buffers
 * streams (a CDN rewrite) sends nothing at all, so this is how the CLI tells
 * the two apart in seconds instead of a full idle timeout.
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 10000;

/** A stream delivered no bytes for `ms` — before its headers (`beforeHeaders`), or mid-stream. */
export class StreamSilent extends Error {
  constructor(readonly ms: number, readonly beforeHeaders: boolean) {
    super(beforeHeaders ? `no response headers within ${ms}ms` : `no bytes for ${ms}ms`);
    this.name = 'StreamSilent';
  }
}

/**
 * An abort signal that fires after `ms` without bytes, and `watch(body)`: the
 * body re-wrapped so that every chunk re-arms the timer and expiry ERRORS the
 * wrapped stream (cancelling the source). Aborting the fetch signal alone is not
 * enough — a read already pending on a returned body is not guaranteed to
 * settle — so the watchdog fails the reader itself.
 */
function idleWatchdog(ms: number, headersMs: number = ms) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExpire: (() => void) | undefined;
  let beforeHeaders = true;
  const expire = (after: number) => { controller.abort(new StreamSilent(after, beforeHeaders)); onExpire?.(); };
  const arm = (after: number = ms) => {
    if (!(after > 0)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => expire(after), after);
  };
  // Until the response headers arrive, the tighter headers timeout applies: a
  // healthy host sends them at once even with no events to report.
  arm(headersMs);
  return {
    signal: controller.signal,
    /** The response headers arrived: from here on only the idle timeout applies. */
    headersArrived() { beforeHeaders = false; arm(); },
    watch(body: any) {
      if (!(ms > 0) || typeof body?.getReader !== 'function') return body;
      const source = body.getReader();
      return new ReadableStream({
        start(out) {
          onExpire = () => {
            out.error(new StreamSilent(ms, false));
            source.cancel().catch(() => {});
          };
        },
        async pull(out) {
          try {
            const { value, done } = await source.read();
            if (done) { out.close(); return; }
            arm();
            out.enqueue(value);
          } catch (err) {
            out.error(err);
          }
        },
        cancel(reason) { return source.cancel(reason); },
      });
    },
    stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined; onExpire = undefined; },
  };
}
