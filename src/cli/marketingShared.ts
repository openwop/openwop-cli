import type { Ctx } from '../context.js';
/**
 * Shared plumbing for the marketing command groups (brand-kits, campaign-brief,
 * campaign-connectors, campaign-intel, campaign-journeys, cdp, destination-sync,
 * discovery, funnels, webinars, public) plus the `public` legs added to the
 * email / forms / chat-widget groups.
 *
 * Each group declares a table of subcommands (`Cmd`) and hands it to
 * `dispatchTable`, which owns the parse / --help / usage-error / --yes gate so
 * every group behaves identically. `requestRaw` covers the non-JSON public
 * surfaces (RSS/XML/Markdown/HTML/JS/audio, the tracking pixel, the click
 * redirect) without touching src/api.ts: it reuses the same protocol rewrite
 * (`resolveRequest`) so a `/v1/host/openwop-app/...` literal still lands on the
 * advertised host root under protocol major 2.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { parseJsonResponse } from '../api.js';
import { readBodyOption, parseJsonFlag as parseJsonFlagShared, withQuery } from './contentHelpers.js';
import { resolveRequest } from '../protocol.js';

export const APP = '/v1/host/openwop-app';
export { enc } from './contentHelpers.js';

export interface CmdArgs {
  options: Record<string, any>;
  positionals: string[];
  /** Merged `--body-file` then `--body` JSON object (empty when neither given). */
  body: Record<string, any>;
}

export interface Cmd {
  /** Usage line WITHOUT the `openwop <group> ` prefix. */
  usage: string;
  /** Exact number of required positionals. */
  args?: number;
  bool?: string[];
  value?: string[];
  multi?: string[];
  /** Accept `--body <json>` / `--body-file <path>`. */
  body?: boolean;
  /** Required option keys (camelCased), checked after parsing. Satisfied by the body too when `bodyKey` maps it. */
  requires?: string[];
  /** Destructive: refuse without `--yes` (exit 2). The value names the action for the refusal line. */
  confirm?: string;
  run: (ctx: Ctx, a: CmdArgs) => Promise<number>;
}

/** Parse + dispatch one subcommand of a table-driven group. */
export async function dispatchTable(
  ctx: Ctx,
  group: string,
  help: string,
  table: Record<string, Cmd>,
  argv: string[],
  defaultSub: string,
): Promise<number> {
  const sub = argv[0] ?? defaultSub;
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, help); return 0; }
  const cmd = table[sub];
  if (!cmd) throw new CliError(`Unknown ${group} command: ${sub}\nRun \`openwop ${group} --help\` for usage.`);
  const rest = argv.slice(1);
  const { options, positionals } = parseOptions(rest, {
    bool: ['--help', ...(cmd.confirm ? ['--yes'] : []), ...(cmd.bool ?? [])],
    value: [...(cmd.body ? ['--body', '--body-file'] : []), ...(cmd.value ?? [])],
    multi: cmd.multi ?? [],
  });
  const usage = `Usage: openwop ${group} ${cmd.usage}\n`;
  if (options.help) { write(ctx.io.stdout, usage); return 0; }
  if (cmd.args !== undefined && positionals.length !== cmd.args) { write(ctx.io.stderr, usage); return 2; }
  const body = cmd.body ? readBody(ctx, options) : {};
  for (const key of cmd.requires ?? []) {
    if (options[key] === undefined && body[key] === undefined) {
      write(ctx.io.stderr, `openwop: missing --${kebab(key)}\n${usage}`);
      return 2;
    }
  }
  if (cmd.confirm && !options.yes) {
    writeLine(ctx.io.stderr, `Refusing to ${cmd.confirm} without --yes.`);
    return 2;
  }
  return cmd.run(ctx, { options, positionals, body });
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** `--body <json>` / `--body-file <path>` as an object (empty when neither given) — delegates to contentHelpers. */
export function readBody(ctx: Ctx, options: Record<string, any>): Record<string, any> {
  return readBodyOption(ctx, options) ?? {};
}

/** Parse a JSON flag value (legible usage error) — delegates to contentHelpers. */
export function parseJsonFlag(text: string, flag: string): unknown {
  return parseJsonFlagShared(flag, text);
}

/** A JSON flag that must be an object (legible usage error otherwise). */
export function jsonObject(text: string, flag: string): Record<string, any> {
  const v = parseJsonFlag(text, flag);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new CliError(`${flag} must be a JSON object.`, 2);
  return v as Record<string, any>;
}

/** Read a local file as UTF-8 text (usage error when unreadable). */
export function readText(ctx: Ctx, path: string, flag: string): string {
  try { return readFileSync(resolvePath(ctx.cwd, path), 'utf8'); } catch (err) {
    throw new CliError(`Cannot read ${flag} ${path}: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
}

/** Read a local file as base64 (usage error when unreadable). */
export function readBase64(ctx: Ctx, path: string, flag: string): string {
  try { return readFileSync(resolvePath(ctx.cwd, path)).toString('base64'); } catch (err) {
    throw new CliError(`Cannot read ${flag} ${path}: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
}

/** Positive finite number from a flag (usage error otherwise). */
export function num(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number.`, 2);
  return n;
}

/** Copy the defined, flag-supplied fields onto a body (flags win over --body). */
export function assign(body: Record<string, any>, fields: Record<string, unknown>): Record<string, any> {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
  return body;
}

/** `?a=1&b=2`, skipping undefined/empty values ('' when nothing remains) — delegates to contentHelpers. */
export function qs(params: Record<string, unknown>): string {
  return withQuery('', params);
}

/** Print a response: raw JSON under --json, else the human renderer. */
export function emit(ctx: Ctx, body: unknown, human: () => void): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  human();
  return 0;
}

/** A detail view: --json raw; human = pretty JSON of `key` (or the whole body). */
export function detail(ctx: Ctx, body: any, key?: string): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  writeJson(ctx.io.stdout, key && body && typeof body === 'object' && key in body ? body[key] : body);
  return 0;
}

export type Column = string | [string, (row: any) => unknown];

/** A list view: --json raw; human = a table of `body[key]`, or `empty` when none. */
export function listOut(ctx: Ctx, body: any, key: string, columns: Column[], empty: string): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  const items = Array.isArray(body?.[key]) ? body[key] : Array.isArray(body) ? body : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, empty); return 0; }
  writeLine(ctx.io.stdout, table(items, columns));
  return 0;
}

export function table(items: any[], columns: Column[]): string {
  const names = columns.map((c) => (typeof c === 'string' ? c : c[0]));
  const rows = items.map((it) => Object.fromEntries(columns.map((c) => {
    const [name, get] = typeof c === 'string' ? [c, (r: any) => r?.[c]] : c;
    return [name, cell(get(it))];
  })));
  return formatTable(rows, names);
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return String(v.length);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A write result: --json raw; human = the one-line summary. */
export function done(ctx: Ctx, body: unknown, line: string): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body ?? {}); return 0; }
  writeLine(ctx.io.stdout, line);
  return 0;
}

// ── raw (non-JSON) requests ──────────────────────────────────────────────────

export interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Pre-encoded request body (JSON callers use requestJson instead). */
  body?: string;
  /** 'manual' reports a 3xx (e.g. the click redirect) instead of following it. */
  redirect?: 'follow' | 'manual';
  /** Throw HttpError on a non-2xx (default true; a 3xx under 'manual' never throws). */
  throwOnError?: boolean;
  auth?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  contentType: string;
  bytes: Buffer;
  text: () => string;
}

/** Fetch a host path without JSON-parsing it (feeds, pages, scripts, audio). */
export async function requestRaw(ctx: Ctx, requestedPath: string, options: RawOptions = {}): Promise<RawResponse> {
  const { path, headers } = await resolveRequest(ctx, requestedPath, { accept: '*/*', ...(options.headers ?? {}) });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (options.auth !== false && ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const res = await ctx.fetchImpl(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    redirect: options.redirect ?? 'follow',
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? '';
  const isRedirect = res.status >= 300 && res.status < 400;
  if (!res.ok && !isRedirect && options.throwOnError !== false) {
    const text = bytes.toString('utf8');
    throw new HttpError(`HTTP ${res.status}`, res.status, text.length ? parseJsonResponse(text) : null);
  }
  return { status: res.status, headers: res.headers, contentType, bytes, text: () => bytes.toString('utf8') };
}

/** Print a text body verbatim (a trailing newline is added when missing). */
export function writeText(ctx: Ctx, text: string): void {
  write(ctx.io.stdout, text.endsWith('\n') ? text : `${text}\n`);
}

/** --json view of a raw response: status + content type + the text body. */
export function rawJson(res: RawResponse, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: res.status, contentType: res.contentType, ...extra, body: res.text() };
}
