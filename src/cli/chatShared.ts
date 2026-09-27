/**
 * Helpers shared by the conversation / messaging groups (chat, assistant,
 * channels, scheduled-chats, voice, ai, a2a, notifications, computer-use,
 * whatsapp, agent-author, workflow-author, workflow-proposals).
 *
 * - `streamHostSse`  — consume a host-extension Server-Sent Events route
 *                       (channel messages, presence, notifications, realtime
 *                       voice transcript) through the SAME path negotiation +
 *                       frame decoder the run stream uses (src/protocol.ts +
 *                       src/sse.ts `consumeSse`), bounded by a timeout and/or
 *                       a frame count so a scripted call always returns.
 * - `emit`           — the `--json` / human output split every command shares.
 * (`--body` / `--body-file` and JSON flag parsing reuse src/cli/contentHelpers.ts.)
 */
import type { Ctx } from '../context.js';
import { CliError, HttpError, httpErrorLine } from '../errors.js';
import { writeJson, writeLine } from '../io.js';
import { resolveRequest } from '../protocol.js';
import { consumeSse } from '../sse.js';

/** URL-encode one path segment (ids may carry `/` or `:`). */
export const enc = (value: string): string => encodeURIComponent(value);

/** Parse a positive integer flag, or throw a legible usage error. */
export function intFlag(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`${flag} must be a non-negative integer`, 2);
  return n;
}

/** `--json` → the raw host body; otherwise run the human renderer. */
export function emit(ctx: Ctx, body: unknown, human: () => void): number {
  if (ctx.json) {
    writeJson(ctx.io.stdout, body);
    return 0;
  }
  human();
  return 0;
}

/** Print `key: value` lines for the defined entries of a record. */
export function writeFields(ctx: Ctx, fields: Array<[string, unknown]>): void {
  for (const [key, value] of fields) {
    if (value === undefined || value === null || value === '') continue;
    writeLine(ctx.io.stdout, `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
}

export interface HostSseOptions {
  /** Called with each decoded frame `{ event, data, id }` (data JSON-parsed when possible). */
  onFrame: (frame: { event?: string; data?: unknown; id?: string }) => void;
  /** Stop after this many data frames (0/undefined = unbounded). */
  maxFrames?: number;
  /** Stop after this many milliseconds (0/undefined = until the server closes). */
  timeoutMs?: number;
}

/**
 * Open a host-extension SSE route and feed frames to `onFrame` until the server
 * closes, `maxFrames` data frames arrived, or `timeoutMs` elapsed. Returns the
 * number of data frames delivered. A non-2xx answer throws `HttpError` (so the
 * dispatcher maps 401/403 → exit 4); a non-stream answer throws a legible
 * CliError instead of mis-parsing JSON as frames.
 */
export async function streamHostSse(ctx: Ctx, requestedPath: string, opts: HostSseOptions): Promise<number> {
  const { path, headers } = await resolveRequest(ctx, requestedPath, { accept: 'text/event-stream' });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let delivered = 0;
  try {
    const res = await ctx.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      throw new HttpError(httpErrorLine(res.status, body), res.status, body, res.headers);
    }
    const ct = res.headers?.get?.('content-type') ?? '';
    if (!ct.includes('text/event-stream') || !res.body || typeof (res.body as any).getReader !== 'function') {
      throw new CliError(`The server did not answer ${requestedPath} with an event stream (content-type: ${ct || 'none'}).`, 1);
    }
    await new Promise<void>((resolve, reject) => {
      const stop = () => { controller.abort(); resolve(); };
      consumeSse(res.body, (frame: any) => {
        // A single network chunk can carry several frames; honour the cap exactly.
        if (frame.data === undefined || controller.signal.aborted) return;
        let data: unknown = frame.data;
        try { data = JSON.parse(frame.data); } catch { /* keep raw text */ }
        delivered += 1;
        opts.onFrame({ event: frame.event, data, id: frame.id });
        if (opts.maxFrames && delivered >= opts.maxFrames) stop();
      }).then(() => resolve(), (err: unknown) => {
        if (controller.signal.aborted) resolve();
        else reject(err);
      });
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof HttpError) && !(err instanceof CliError)) return delivered;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return delivered;
}

/** Render one SSE frame for a human: `[event] <json>`. */
export function renderFrame(frame: { event?: string; data?: unknown }): string {
  const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return `${frame.event ? `[${frame.event}] ` : ''}${data}`;
}
