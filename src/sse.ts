import type { Ctx } from './context.js';
/** Run-event streaming + REPL rendering — SSE with JSON-poll fallback. */

import { createInterface } from 'node:readline';
import { requestJson } from './api.js';
import { CliError, HttpError } from './errors.js';
import { negotiateMajor, resolveRequest } from './protocol.js';
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
 * Stream a run's events. Prefers SSE; on any SSE failure (non-streamable
 * body, non-2xx, or transport error) falls back to the JSON poll endpoint.
 * Calls `onEvent(eventRecord)` once per event in sequence order and resolves
 * when a terminal event is seen or the poll endpoint reports completion.
 */
export async function streamRunEvents(ctx: Ctx, runId: string, { onEvent, useStream = true, timeoutMs = 120000 }: { onEvent?: (e: any) => void; useStream?: boolean; timeoutMs?: number } = {}) {
  if (useStream) {
    try {
      const handled = await streamViaSse(ctx, runId, onEvent);
      if (handled) return;
    } catch {
      // Fall through to polling.
    }
  }
  await streamViaPoll(ctx, runId, onEvent, timeoutMs);
}

async function streamViaSse(ctx: Ctx, runId: string, onEvent: any) {
  // Same negotiation as requestJson (src/protocol.ts): under major 2 this is
  // `/runs/{runId}/events` + `OpenWOP-Version: 2.0`. Joined relative to the
  // base for the same reason api.ts does — a base with a path prefix survives.
  const { path, headers } = await resolveRequest(ctx, `/v1/runs/${encodeURIComponent(runId)}/events`, { accept: 'text/event-stream' });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const res = await ctx.fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, null);
  const ct = res.headers?.get?.('content-type') ?? '';
  if (!ct.includes('text/event-stream') || !res.body || typeof res.body.getReader !== 'function') {
    // Server answered with JSON (or a non-streamable body) — let the
    // caller fall back to polling rather than mis-parsing.
    return false;
  }
  await consumeSse(res.body, (frame: any) => {
    if (frame.data === undefined) return;
    const ev = safeParseJson(frame.data);
    if (frame.event === 'batch' && Array.isArray(ev)) {
      for (const one of ev) onEvent(one);
    } else if (ev && typeof ev === 'object') {
      onEvent(ev);
    }
  });
  return true;
}

/**
 * Decode a web ReadableStream of SSE bytes into frames. Exported for tests so
 * the line-buffering / multi-line `data:` accumulation can be exercised
 * without a live socket. `onFrame` receives `{ event, data, id }`.
 */
export async function consumeSse(stream: any, onFrame: any) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushFrame = (block: string) => {
    if (!block.trim()) return;
    const frame: Record<string, string> = {};
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '' || line.startsWith(':')) continue; // blank or comment/heartbeat
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') frame.event = value;
      else if (field === 'id') frame.id = value;
    }
    if (dataLines.length > 0) frame.data = dataLines.join('\n');
    if (frame.data !== undefined || frame.event !== undefined) onFrame(frame);
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
      flushFrame(buffer);
      break;
    }
  }
}

async function streamViaPoll(ctx: Ctx, runId: string, onEvent: any, timeoutMs: number) {
  const started = Date.now();
  const cursorParam = await pollCursorParam(ctx);
  let lastSequence = -1;
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
