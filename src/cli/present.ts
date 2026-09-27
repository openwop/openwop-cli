import type { Ctx } from '../context.js';
/**
 * `openwop present ...` — the presentation remote (ADR 0328 Phase 4): the phone
 * controller's surface for a presenting canvas.
 *
 * Hits `/v1/host/openwop-app/present/<token>/{outline,command,state,events}`.
 * TOKEN-AUTHED: the signed present token IS the credential, so these calls send
 * no API key. Every failure (unknown, expired, forged) is a uniform 404.
 * `events` is a server-sent-event feed of `nav` events.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, parseJsonResponse } from '../api.js';
import { resolveStreamRequest } from '../protocol.js';
import { consumeSse } from '../sse.js';
import { enc, renderDone } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/present';
const ACTIONS = ['next', 'prev', 'goto', 'blank'];

export const PRESENT_HELP = `Usage:
  openwop present outline <token> [--json]
  openwop present command <token> next|prev|blank [--json]
  openwop present command <token> goto --index <n> [--json]
  openwop present state <token> --current <n> [--json]
  openwop present events <token> [--max <n>] [--timeout <seconds>] [--json]

Drive a live presentation with its remote token (no API key — the token is the
credential). \`outline\` reads { title, frames, current? } (GET ${BASE}/<token>/outline).
\`command\` sends a navigation command (POST ${BASE}/<token>/command, body
{ action, index? }). \`state\` reports the presenter's current frame
(POST ${BASE}/<token>/state, body { current }). \`events\` follows the navigation
feed (GET ${BASE}/<token>/events, server-sent events) — one line per event, or one
JSON object per line with --json; stops after --max events or --timeout seconds.

Exit codes: 0 ok · 2 usage / unknown or expired session.

Examples:
  openwop present outline pr_tok
  openwop present command pr_tok goto --index 3
  openwop present events pr_tok --max 5 --json
`;

export async function runPresent(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, PRESENT_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--index', '--current', '--max', '--timeout'] });
  if (options.help) { write(ctx.io.stdout, PRESENT_HELP); return 0; }
  const token = positionals[0];
  if (!token) { write(ctx.io.stderr, `Usage: openwop present ${sub} <token> ...\n`); return 2; }
  const base = `${BASE}/${enc(token)}`;
  switch (sub) {
    case 'outline': {
      const res = await requestJson(ctx, `${base}/outline`, { auth: false });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const frames: any[] = Array.isArray(res.body?.frames) ? res.body.frames : [];
      writeLine(ctx.io.stdout, `${res.body?.title ?? '(untitled)'} — ${frames.length} frame(s)${typeof res.body?.current === 'number' ? `, current ${res.body.current}` : ''}`);
      if (frames.length) writeLine(ctx.io.stdout, formatTable(frames.map((f, i) => ({ index: i, title: typeof f === 'string' ? f : (f?.title ?? f?.label ?? '') })), ['index', 'title']));
      return 0;
    }
    case 'command': {
      const action = positionals[1];
      if (!action || !ACTIONS.includes(action)) { write(ctx.io.stderr, `present command needs an action: ${ACTIONS.join('|')}.\n`); return 2; }
      const body: Record<string, unknown> = { action };
      if (action === 'goto') {
        const index = Number(options.index);
        if (options.index === undefined || !Number.isInteger(index) || index < 0) { write(ctx.io.stderr, 'present command goto needs --index <non-negative integer>.\n'); return 2; }
        body.index = index;
      }
      const res = await requestJson(ctx, `${base}/command`, { method: 'POST', body, auth: false });
      return renderDone(ctx, res.body, `Sent ${action}${action === 'goto' ? ` ${String(body.index)}` : ''}.`);
    }
    case 'state': {
      const current = Number(options.current);
      if (options.current === undefined || !Number.isInteger(current) || current < 0) { write(ctx.io.stderr, 'present state needs --current <non-negative integer>.\n'); return 2; }
      const res = await requestJson(ctx, `${base}/state`, { method: 'POST', body: { current }, auth: false });
      return renderDone(ctx, res.body, `Reported current frame ${current}.`);
    }
    case 'events': return followEvents(ctx, `${base}/events`, options);
    default: throw new CliError(`Unknown present command: ${sub}\nRun \`openwop present --help\` for usage.`);
  }
}

async function followEvents(ctx: Ctx, requestedPath: string, options: Record<string, any>): Promise<number> {
  const max = options.max !== undefined ? Number(options.max) : Infinity;
  const timeoutMs = options.timeout !== undefined ? Number(options.timeout) * 1000 : Infinity;
  if (Number.isNaN(max) || Number.isNaN(timeoutMs)) throw new CliError('--max and --timeout must be numbers.');
  // Via the one stream seam — which also attaches the bearer this call used to omit.
  const { url, headers } = await resolveStreamRequest(ctx, requestedPath, {});
  const controller = new AbortController();
  const timer = Number.isFinite(timeoutMs) ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let seen = 0;
  try {
    const res = await ctx.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(`HTTP ${res.status}`, res.status, text ? parseJsonResponse(text) : null);
    }
    if (!res.body) return 0;
    await consumeSse(res.body, (frame: { event?: string; data?: string }) => {
      if (seen >= max) return;
      let data: unknown = frame.data;
      try { data = frame.data !== undefined ? JSON.parse(frame.data) : undefined; } catch { /* keep raw */ }
      seen += 1;
      if (ctx.json) writeLine(ctx.io.stdout, JSON.stringify({ event: frame.event ?? 'message', data }));
      else {
        const d = data as { kind?: string; action?: string; index?: number; current?: number } | undefined;
        const detail = d?.kind === 'command' ? `${d.action ?? ''}${d.index !== undefined ? ` ${d.index}` : ''}` : d?.kind === 'position' ? `current ${d.current}` : JSON.stringify(data);
        writeLine(ctx.io.stdout, `${frame.event ?? 'message'}: ${d?.kind ?? ''} ${detail}`.replace(/\s+/g, ' ').trim());
      }
      if (seen >= max) controller.abort();
    });
  } catch (err) {
    if (!(err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted))) throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return 0;
}
