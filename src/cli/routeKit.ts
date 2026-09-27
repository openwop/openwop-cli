import type { Ctx } from '../context.js';
/**
 * Declarative subcommand kit for host-extension route families.
 *
 * Many `/v1/host/openwop-app/*` surfaces are thin CRUD families (dozens of
 * routes per feature). Rather than hand-roll one function per route, a group
 * declares a `RouteCmd[]` table — the words, the method + path template, the
 * query/body flags (named after the host's own field names) — and this module
 * does the parse → request → render loop. Usage + endpoint help lines are
 * generated from the same table, so the help text can never drift from what a
 * command actually sends.
 *
 * Conventions honoured (see CLAUDE.md "House conventions"):
 *   - positionals fill the path's `:params` in order, each `encodeURIComponent`d;
 *   - `--json` prints the raw host body; the human default is a table (when the
 *     command declares one) or pretty JSON;
 *   - writes accept `--body <json>` / `--body-file <path>` for nested bodies,
 *     with the typed flags overlaid on top;
 *   - a DELETE (or any `confirm` command) refuses without `--yes` (exit 2);
 *   - 401/403 → exit 4 with the host's message; other 4xx → exit 2; 5xx → 1.
 */
import { readFileSync } from 'node:fs';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

/**
 * `file` reads a local file's text into the field (one trailing newline dropped, so
 * a token file works); `map` is a repeatable `key=value` flag collected into an
 * object (numeric values become numbers); `file64` reads a local file as base64
 * (for hosts that take an upload inline in a JSON body).
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'json' | 'list' | 'csv' | 'file' | 'file64' | 'map';

/** A flag that maps onto a body (or query) field. `key` may be dotted (`a.b`). */
export interface FieldSpec {
  flag: string;
  key: string;
  type?: FieldType;
  required?: boolean;
  help?: string;
}

export interface RouteCmd {
  /** Subcommand words after the group name, e.g. `['lists', 'ideas', 'create']`. */
  words: string[];
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Path template(s) with `:params`. When several are given, the one whose param
   * count equals the number of positionals is used (e.g. an optional id).
   */
  path: string | string[];
  summary: string;
  query?: FieldSpec[];
  body?: FieldSpec[];
  /** Send `{}` even when no body flags were given (most POST verbs). Default: true for POST. */
  emptyBody?: boolean;
  /** Require `--yes`. Default: true for DELETE. */
  confirm?: boolean;
  /** Send without the bearer (public / anonymous visitor surfaces). */
  anonymous?: boolean;
  /** Table rendering for reads: which body key holds the rows + the columns to show. */
  table?: { key?: string; columns: string[]; empty?: string };
  /**
   * Read-modify-write for routes that REPLACE a document on write: GET `from`
   * (default: the same path), take `pick(body)` as the base, overlay the flags.
   */
  rmw?: { from?: string; pick?: (body: any) => any };
  /**
   * Non-2xx statuses that still carry a meaningful body (e.g. a readiness probe
   * answering 503 `degraded`): the body is rendered and the command exits 1.
   */
  bodyOnError?: number[];
  /** Extra usage hint (positional names are derived from the path). */
  usage?: string;
}

const COMMON_BOOL = ['--help', '--yes'];

function templates(cmd: RouteCmd): string[] {
  return Array.isArray(cmd.path) ? cmd.path : [cmd.path];
}

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1] as string);
}

function flagHint(f: FieldSpec): string {
  const t = f.type ?? 'string';
  const v = t === 'boolean' ? '' : t === 'file' || t === 'file64' ? ' <path>' : t === 'map' ? ' <key=value>...' : t === 'list' ? ` <${f.key}>...` : t === 'json' ? ` <json>` : ` <${f.key.split('.').pop()}>`;
  return f.required ? `${f.flag}${v}` : `[${f.flag}${v}]`;
}

/** One usage line per command: `openwop <group> <words> <params> [flags]`. */
export function usageLine(group: string, cmd: RouteCmd): string {
  const paths = templates(cmd);
  const longest = paths.reduce((a, b) => (paramNames(b).length > paramNames(a).length ? b : a));
  const shortest = paths.reduce((a, b) => (paramNames(b).length < paramNames(a).length ? b : a));
  const req = paramNames(shortest);
  const params = paramNames(longest).map((p, i) => (i < req.length ? `<${p}>` : `[<${p}>]`));
  const flags = [...(cmd.query ?? []), ...(cmd.body ?? [])].map(flagHint);
  if (cmd.body?.some((f) => f.type === 'json')) flags.push('[--body <json>|--body-file <path>]');
  if (cmd.confirm ?? cmd.method === 'DELETE') flags.push('--yes');
  if (cmd.method === 'GET') flags.push('[--json]');
  return ['openwop', group, ...cmd.words, ...params, ...flags, cmd.usage ?? ''].filter(Boolean).join(' ');
}

/** Help block: usage lines + an endpoint map (`METHOD path — summary`). */
export function routesHelp(group: string, cmds: RouteCmd[]): string {
  const usage = cmds.map((c) => `  ${usageLine(group, c)}`).join('\n');
  const endpoints = cmds.map((c) => `  ${c.words.join(' ').padEnd(28)} ${c.method.padEnd(6)} ${templates(c).join(' | ')}\n  ${''.padEnd(28)} ${c.summary}`).join('\n');
  return `${usage}\n\nEvery write also accepts --body <json> / --body-file <path> for the full request body (typed flags override it).\n\nEndpoints:\n${endpoints}\n`;
}

/** The command whose `words` are the longest prefix of `argv`, or undefined. */
export function matchRoute(cmds: RouteCmd[], argv: string[]): RouteCmd | undefined {
  let best: RouteCmd | undefined;
  for (const cmd of cmds) {
    if (cmd.words.length > argv.length) continue;
    if (!cmd.words.every((w, i) => argv[i] === w)) continue;
    if (!best || cmd.words.length > best.words.length) best = cmd;
  }
  return best;
}

function setPath(target: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node[part] = typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part]) ? {} : { ...node[part] };
    node = node[part];
  }
  node[parts[parts.length - 1] as string] = value;
}

function coerce(f: FieldSpec, raw: unknown): unknown {
  const t = f.type ?? 'string';
  if (t === 'boolean') return raw;
  if (t === 'list') return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  if (t === 'map') {
    const out: Record<string, string | number> = {};
    for (const pair of Array.isArray(raw) ? raw : [raw]) {
      const text = String(pair);
      const eq = text.indexOf('=');
      if (eq <= 0) throw new CliError(`${f.flag} expects key=value (got "${text}").`, 2);
      const v = text.slice(eq + 1);
      out[text.slice(0, eq)] = v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return out;
  }
  const s = String(raw);
  if (t === 'number') {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new CliError(`${f.flag} must be a number (got "${s}").`, 2);
    return n;
  }
  if (t === 'file64') {
    try { return readFileSync(s).toString('base64'); }
    catch (err) { throw new CliError(`Could not read ${s} for ${f.flag}: ${err instanceof Error ? err.message : String(err)}`, 2); }
  }
  if (t === 'file') {
    try { return readFileSync(s, 'utf8').replace(/\r?\n$/, ''); }
    catch (err) { throw new CliError(`Could not read ${s} for ${f.flag}: ${err instanceof Error ? err.message : String(err)}`, 2); }
  }
  if (t === 'csv') return s.split(',').map((x) => x.trim()).filter(Boolean);
  if (t === 'json') {
    try { return JSON.parse(s); } catch { throw new CliError(`${f.flag} must be valid JSON.`, 2); }
  }
  return s;
}

function readBodyOptions(options: Record<string, any>): Record<string, any> {
  let raw: string | undefined;
  if (options.bodyFile !== undefined) {
    try { raw = readFileSync(String(options.bodyFile), 'utf8'); }
    catch (err) { throw new CliError(`Could not read ${String(options.bodyFile)}: ${err instanceof Error ? err.message : String(err)}`, 2); }
  } else if (options.body !== undefined) {
    raw = String(options.body);
  }
  if (raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError('--body / --body-file must be a JSON object.', 2); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('--body / --body-file must be a JSON object.', 2);
  return parsed as Record<string, any>;
}

/** Legible error mapping: 401/403 → exit 4, other 4xx → 2, 5xx → 1. */
export function hostError(err: HttpError): CliError {
  const b = err.body as Record<string, unknown> | null;
  const parts = [b?.message, b?.error, b?.reason].filter((x) => typeof x === 'string' && x.length > 0) as string[];
  const detail = parts.length ? `: ${[...new Set(parts)].join(' — ')}` : '';
  if (err.status === 401) return new CliError(`HTTP 401${detail} (not signed in — pass --api-key)`, 4);
  if (err.status === 403) return new CliError(`HTTP 403${detail} (permission denied)`, 4);
  if (err.status === 404) return new CliError(`HTTP 404${detail} (not found, or the feature is not enabled on this host)`, 2);
  return new CliError(`HTTP ${err.status}${detail}`, err.status >= 500 ? 1 : 2);
}

/** Parse + send + render one declared command. `argv` still includes the words. */
export async function runRoute(ctx: Ctx, group: string, cmd: RouteCmd, argv: string[]): Promise<number> {
  const rest = argv.slice(cmd.words.length);
  const fields = [...(cmd.query ?? []), ...(cmd.body ?? [])];
  const bool = [...COMMON_BOOL, ...fields.filter((f) => f.type === 'boolean').flatMap((f) => [f.flag, f.flag.replace(/^--/, '--no-')])];
  const isMulti = (f: FieldSpec) => f.type === 'list' || f.type === 'map';
  const value = ['--body', '--body-file', ...fields.filter((f) => f.type !== 'boolean' && !isMulti(f)).map((f) => f.flag)];
  const multi = fields.filter(isMulti).map((f) => f.flag);
  const { options, positionals } = parseOptions(rest, { bool, value, multi });
  if (options.help) { writeLine(ctx.io.stdout, `Usage: ${usageLine(group, cmd)}\n\n${cmd.summary}\nEndpoint: ${cmd.method} ${templates(cmd).join(' | ')}`); return 0; }

  const template = templates(cmd).find((p) => paramNames(p).length === positionals.length);
  if (!template) { write(ctx.io.stderr, `Usage: ${usageLine(group, cmd)}\n`); return 2; }
  let path = template;
  paramNames(template).forEach((name, i) => { path = path.replace(`:${name}`, encodeURIComponent(positionals[i] as string)); });

  const optionOf = (f: FieldSpec): unknown => {
    const name = f.flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (f.type === 'boolean') {
      const neg = `no${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      if (options[name]) return true;
      if (options[neg]) return false;
      return undefined;
    }
    return options[name];
  };

  const qs = new URLSearchParams();
  for (const f of cmd.query ?? []) {
    const v = optionOf(f);
    if (v === undefined) { if (f.required) throw new CliError(`${usageLine(group, cmd)}\n${f.flag} is required.`, 2); continue; }
    const c = coerce(f, v);
    if (Array.isArray(c)) c.forEach((x) => qs.append(f.key, String(x))); else qs.set(f.key, String(c));
  }
  const url = qs.size ? `${path}${path.includes('?') ? '&' : '?'}${qs.toString()}` : path;

  const confirm = cmd.confirm ?? cmd.method === 'DELETE';
  if (confirm && !options.yes) throw new CliError(`Refusing to ${cmd.words.join(' ')} ${positionals.join(' ')} without --yes.`.replace(/\s+/g, ' ').trim(), 2);

  let body: Record<string, any> | undefined;
  const isWrite = cmd.method !== 'GET' && cmd.method !== 'DELETE';
  if (isWrite || cmd.body?.length) {
    const explicit = readBodyOptions(options);
    const overlay: Record<string, any> = {};
    for (const f of cmd.body ?? []) {
      const v = optionOf(f);
      if (v === undefined) continue;
      setPath(overlay, f.key, coerce(f, v));
    }
    let base: Record<string, any> = {};
    if (cmd.rmw) {
      let from = cmd.rmw.from ?? template;
      paramNames(from).forEach((name, i) => { from = from.replace(`:${name}`, encodeURIComponent(positionals[i] as string)); });
      const current = await send(ctx, from, { method: 'GET' }, cmd.anonymous);
      const picked = cmd.rmw.pick ? cmd.rmw.pick(current.body) : current.body;
      base = picked && typeof picked === 'object' && !Array.isArray(picked) ? { ...picked } : {};
    }
    body = { ...base, ...explicit };
    // Deep-apply each flag so a dotted key (`policy.roles`) edits inside a
    // read-modify-write base instead of replacing the whole sub-object.
    for (const f of cmd.body ?? []) {
      const v = getPath(overlay, f.key);
      if (v !== undefined) setPath(body, f.key, v);
    }
    for (const f of cmd.body ?? []) {
      if (f.required && getPath(body, f.key) === undefined) throw new CliError(`${usageLine(group, cmd)}\n${f.flag} is required.`, 2);
    }
    if (!isWrite && Object.keys(body).length === 0) body = undefined;
    if (isWrite && body && Object.keys(body).length === 0 && cmd.emptyBody === false) body = undefined;
  }

  try {
    const res = await requestJson(ctx, url, { method: cmd.method, ...(body !== undefined ? { body } : {}), ...(cmd.anonymous ? { auth: false } : {}) });
    render(ctx, cmd, positionals, res.status, res.body);
    return 0;
  } catch (err) {
    if (err instanceof HttpError && cmd.bodyOnError?.includes(err.status)) {
      render(ctx, { ...cmd, method: 'GET' }, positionals, err.status, err.body);
      return 1;
    }
    if (err instanceof HttpError) throw hostError(err);
    throw err;
  }
}

function getPath(obj: Record<string, any>, key: string): unknown {
  return key.split('.').reduce<any>((node, part) => (node && typeof node === 'object' ? node[part] : undefined), obj);
}

async function send(ctx: Ctx, url: string, init: { method: string; body?: unknown }, anonymous?: boolean) {
  try {
    return await requestJson(ctx, url, { method: init.method, ...(init.body !== undefined ? { body: init.body } : {}), ...(anonymous ? { auth: false } : {}) });
  } catch (err) {
    if (err instanceof HttpError) throw hostError(err);
    throw err;
  }
}

function render(ctx: Ctx, cmd: RouteCmd, positionals: string[], status: number, body: any): void {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return; }
  if (cmd.method === 'GET' && cmd.table) {
    const rows = cmd.table.key ? getPath(body ?? {}, cmd.table.key) : body;
    if (Array.isArray(rows)) {
      if (rows.length === 0) { writeLine(ctx.io.stdout, cmd.table.empty ?? 'None.'); return; }
      const flat = rows.map((r: any) => Object.fromEntries(cmd.table!.columns.map((c) => {
        const v = getPath(r ?? {}, c);
        return [c, v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)];
      })));
      writeLine(ctx.io.stdout, formatTable(flat, cmd.table.columns));
      return;
    }
  }
  if (cmd.method === 'GET') { writeJson(ctx.io.stdout, body); return; }
  const target = positionals.length ? ` ${positionals.join(' ')}` : '';
  writeLine(ctx.io.stdout, `OK — ${cmd.words.join(' ')}${target} (HTTP ${status}).`);
  if (body !== null && body !== undefined && !(typeof body === 'object' && Object.keys(body).length === 0) && !ctx.quiet) writeJson(ctx.io.stdout, body);
}

/**
 * Dispatch helper for a group made entirely (or partly) of declared commands.
 * Returns `undefined` when no declared command matches, so a hand-written group
 * can fall through to its own switch.
 */
export async function dispatchRoutes(ctx: Ctx, group: string, cmds: RouteCmd[], argv: string[], guard?: (ctx: Ctx) => Promise<void>): Promise<number | undefined> {
  const cmd = matchRoute(cmds, argv);
  if (!cmd) return undefined;
  // A group that fails closed on an unadvertised surface passes its probe here,
  // so declared commands honour the same capability check as hand-written ones.
  if (guard && !argv.slice(cmd.words.length).some((a) => a === '--help' || a === '-h')) await guard(ctx);
  return runRoute(ctx, group, cmd, argv);
}

/**
 * A whole group driven by a route table: `--help`/no-args prints `help`, a
 * matching command runs, anything else is a legible usage error (exit 2).
 */
export async function runRouteGroup(ctx: Ctx, group: string, help: string, cmds: RouteCmd[], argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { write(ctx.io.stdout, help); return 0; }
  const code = await dispatchRoutes(ctx, group, cmds, argv);
  if (code !== undefined) return code;
  throw new CliError(`Unknown ${group} command: ${argv.join(' ')}\nRun \`openwop ${group} --help\` for usage.`, 2);
}
