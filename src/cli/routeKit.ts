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
import { CliError, HttpError, describeHttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

/**
 * `boolean` is a presence flag (`--x` / `--no-x`); `bool` is a VALUED boolean
 * (`--x true|false|yes|no|1|0`). `csv` is one comma-separated value → string[]
 * (sent back comma-joined when it is a query field); `list` is a repeatable flag.
 * `file` reads a local file's text into the field (one trailing newline dropped, so
 * a token file works); `map` is a repeatable `key=value` flag collected into an
 * object (numeric values become numbers); `file64` reads a local file as base64
 * (for hosts that take an upload inline in a JSON body); `json-file` reads and
 * parses a local JSON file.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'bool' | 'json' | 'list' | 'csv' | 'file' | 'file64' | 'json-file' | 'map';

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
  table?: {
    key?: string; columns: string[]; empty?: string;
    /** Rows are the body when it is an array, else `body[key]` when that is one, else the first array-valued field (none → `empty`). */
    anyArray?: boolean;
  };
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
  /** Constant body fields sent under every request (flags and --body override them). */
  fixed?: Record<string, unknown>;
  /** Applied to the host body before ANY output, `--json` included (e.g. a secret redactor). */
  transform?: (body: any) => any;
  /** Custom human rendering (the `--json` path always prints the raw body). */
  human?: (body: any) => string;
  /** Extra usage hint (positional names are derived from the path). */
  usage?: string;
  /**
   * Bind an exact `:org` path param (not `:orgId`) to a required `--org <orgId>`
   * flag (via `requireOrg`) instead of a positional. Default: false.
   */
  orgFlag?: boolean;
  /** Accept `--body <json>` / `--body-file <path>`; when true the body is built even for GET/DELETE. Default: accepted, built for writes + body flags. */
  bodyFlags?: boolean;
  /** Printed to stderr (one line) just before the request — e.g. a secret-reveal warning. */
  notice?: string;
  /** Human mode: a non-JSON response (`{ raw }`, e.g. CSV) is written verbatim. Default: false. */
  rawText?: boolean;
  /**
   * The host answered with no body: print this line (`{status}` is replaced) in
   * human mode, and `{ ok: true, status }` under `--json`. Default: unset
   * (null is rendered like any other body).
   */
  noContent?: string;
  /** Human rendering of a write with no table/human renderer: `summary` (the OK line + body, default) or `json` (the body only). */
  writeOutput?: 'summary' | 'json';
  /** Wrap host errors with a hint + exit-code mapping (`hostError`). `false` rethrows the HttpError as-is. Default: true. */
  hostErrors?: boolean;
  /**
   * Validate every input (query, body flags, required fields) BEFORE the `--yes`
   * gate and before any read-modify-write GET, field by field in declaration
   * order; required body fields are satisfied by the flags + `--body` only (not
   * by the read-modify-write base). Default: false (gate first, required checked
   * after the merge).
   */
  validateFirst?: boolean;
  /** `number` fields reject a blank value (`--n=`) instead of reading it as 0. Default: false. */
  strictNumbers?: boolean;
  /** Printed verbatim for `--help` (stdout) and a positional-count mismatch (stderr) instead of the generated usage. */
  usageText?: string;
  /** Override individual user-facing error messages (defaults: `DEFAULT_MESSAGES`). */
  messages?: Partial<RouteMessages>;
}

/** Every user-facing error message the runner can raise (each a usage error, exit 2). */
export interface RouteMessages {
  required: (flag: string, usage: string) => string;
  refusal: (words: string[], positionals: string[]) => string;
  invalidNumber: (flag: string, raw: string) => string;
  invalidBool: (flag: string, raw: string) => string;
  invalidJson: (flag: string, raw: string) => string;
  unreadable: (flag: string, path: string, err: unknown) => string;
  unreadableBody: (path: string, err: unknown) => string;
  invalidBodyJson: string;
  bodyNotObject: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const DEFAULT_MESSAGES: RouteMessages = {
  required: (flag, usage) => `${usage}\n${flag} is required.`,
  refusal: (words, positionals) => `Refusing to ${words.join(' ')} ${positionals.join(' ')} without --yes.`.replace(/\s+/g, ' ').trim(),
  invalidNumber: (flag, raw) => `${flag} must be a number (got "${raw}").`,
  invalidBool: (flag, raw) => `${flag} must be true or false (got "${raw}").`,
  invalidJson: (flag) => `${flag} must be valid JSON.`,
  unreadable: (flag, path, err) => `Could not read ${path} for ${flag}: ${errText(err)}`,
  unreadableBody: (path, err) => `Could not read ${path}: ${errText(err)}`,
  invalidBodyJson: '--body / --body-file must be a JSON object.',
  bodyNotObject: '--body / --body-file must be a JSON object.',
};

const COMMON_BOOL = ['--help', '--yes'];

function templates(cmd: RouteCmd): string[] {
  return Array.isArray(cmd.path) ? cmd.path : [cmd.path];
}

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1] as string);
}

/** The params a positional fills (an `orgFlag` command's exact `:org` is a flag). */
function positionalNames(cmd: RouteCmd, path: string): string[] {
  return paramNames(path).filter((p) => !(cmd.orgFlag && p === 'org'));
}

function bindsOrg(cmd: RouteCmd): boolean {
  return Boolean(cmd.orgFlag) && templates(cmd).some((p) => paramNames(p).includes('org'));
}

/** Fill a template's params in ONE pass (a value can never be re-substituted), each encoded. */
function fillPath(cmd: RouteCmd, template: string, positionals: string[], org: unknown): string {
  let i = 0;
  return template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_m, name: string) => {
    if (cmd.orgFlag && name === 'org') return encodeURIComponent(requireOrg(org));
    return encodeURIComponent(positionals[i++] ?? '');
  });
}

function flagHint(f: FieldSpec): string {
  const t = f.type ?? 'string';
  const v = t === 'boolean' ? '' : t === 'bool' ? ' <true|false>' : t === 'file' || t === 'file64' || t === 'json-file' ? ' <path>' : t === 'map' ? ' <key=value>...' : t === 'list' ? ` <${f.key}>...` : t === 'json' ? ` <json>` : ` <${f.key.split('.').pop()}>`;
  return f.required ? `${f.flag}${v}` : `[${f.flag}${v}]`;
}

/** One usage line per command: `openwop <group> <words> <params> [flags]`. */
export function usageLine(group: string, cmd: RouteCmd): string {
  const paths = templates(cmd);
  const longest = paths.reduce((a, b) => (positionalNames(cmd, b).length > positionalNames(cmd, a).length ? b : a));
  const shortest = paths.reduce((a, b) => (positionalNames(cmd, b).length < positionalNames(cmd, a).length ? b : a));
  const req = positionalNames(cmd, shortest);
  const params = positionalNames(cmd, longest).map((p, i) => (i < req.length ? `<${p}>` : `[<${p}>]`));
  const flags = [...(bindsOrg(cmd) ? ['--org <orgId>'] : []), ...[...(cmd.query ?? []), ...(cmd.body ?? [])].map(flagHint)];
  if (cmd.body?.some((f) => f.type === 'json')) flags.push('[--body <json>|--body-file <path>]');
  if (cmd.confirm ?? cmd.method === 'DELETE') flags.push('--yes');
  if (cmd.method === 'GET') flags.push('[--json]');
  return ['openwop', group, ...cmd.words, ...params, ...flags, cmd.usage ?? ''].filter(Boolean).join(' ');
}

/** Help block: usage lines + an endpoint map (`METHOD path — summary`). */
export function routesHelp(group: string, cmds: RouteCmd[]): string {
  const usage = cmds.map((c) => `  ${usageLine(group, c)}`).join('\n');
  const endpoints = cmds.map((c) => `  ${c.words.join(' ').padEnd(28)} ${c.method.padEnd(6)} ${templates(c).join(' | ')}\n  ${''.padEnd(28)} ${c.summary}`).join('\n');
  const writes = cmds.some((c) => c.method !== 'GET' && c.method !== 'DELETE');
  const note = writes ? '\n\nEvery write also accepts --body <json> / --body-file <path> for the full request body (typed flags override it).' : '';
  return `${usage}${note}\n\nEndpoints:\n${endpoints}\n`;
}

/** The command whose `words` are the longest prefix of `argv`, or undefined. */
export function matchRoute<T extends { words: string[] }>(cmds: T[], argv: string[]): T | undefined {
  let best: T | undefined;
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

function coerce(f: FieldSpec, raw: unknown, cmd: RouteCmd, msg: RouteMessages): unknown {
  const t = f.type ?? 'string';
  if (t === 'boolean') return raw;
  if (t === 'bool') {
    const s = String(raw);
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
    throw new CliError(msg.invalidBool(f.flag, s), 2);
  }
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
    if (!Number.isFinite(n) || (cmd.strictNumbers && s.trim() === '')) throw new CliError(msg.invalidNumber(f.flag, s), 2);
    return n;
  }
  if (t === 'json-file') {
    let text: string;
    try { text = readFileSync(s, 'utf8'); }
    catch (err) { throw new CliError(msg.unreadable(f.flag, s, err), 2); }
    try { return JSON.parse(text); } catch { throw new CliError(`${s} (${f.flag}) is not valid JSON.`, 2); }
  }
  if (t === 'file64') {
    try { return readFileSync(s).toString('base64'); }
    catch (err) { throw new CliError(msg.unreadable(f.flag, s, err), 2); }
  }
  if (t === 'file') {
    try { return readFileSync(s, 'utf8').replace(/\r?\n$/, ''); }
    catch (err) { throw new CliError(msg.unreadable(f.flag, s, err), 2); }
  }
  if (t === 'csv') return s.split(',').map((x) => x.trim()).filter(Boolean);
  if (t === 'json') {
    try { return JSON.parse(s); } catch { throw new CliError(msg.invalidJson(f.flag, s), 2); }
  }
  return s;
}

function readBodyOptions(options: Record<string, any>, msg: RouteMessages): Record<string, any> {
  let raw: string | undefined;
  if (options.bodyFile !== undefined) {
    try { raw = readFileSync(String(options.bodyFile), 'utf8'); }
    catch (err) { throw new CliError(msg.unreadableBody(String(options.bodyFile), err), 2); }
  } else if (options.body !== undefined) {
    raw = String(options.body);
  }
  if (raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError(msg.invalidBodyJson, 2); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(msg.bodyNotObject, 2);
  return parsed as Record<string, any>;
}

/**
 * Legible error mapping: the shared `HTTP <status> <code>: <message>` line
 * (src/errors.ts) plus a one-line hint; 401/403 → exit 4, other 4xx → 2, 5xx → 1.
 */
export function hostError(err: HttpError): CliError {
  const line = describeHttpError(err);
  const hint = err.status === 401 ? 'Not signed in — pass --api-key (or run `openwop onboard`).'
    : err.status === 403 ? 'Permission denied for this principal.'
    : err.status === 404 ? 'Not found — or the feature is not enabled on this host.'
    : undefined;
  const code = err.status === 401 || err.status === 403 ? 4 : err.status >= 500 ? 1 : 2;
  return new CliError(hint ? `${line}\n  ${hint}` : line, code);
}

/** Parse + send + render one declared command. `argv` still includes the words. */
export async function runRoute(ctx: Ctx, group: string, cmd: RouteCmd, argv: string[]): Promise<number> {
  const msg: RouteMessages = { ...DEFAULT_MESSAGES, ...(cmd.messages ?? {}) };
  const rest = argv.slice(cmd.words.length);
  const fields = [...(cmd.query ?? []), ...(cmd.body ?? [])];
  const bool = [...COMMON_BOOL, ...fields.filter((f) => f.type === 'boolean').flatMap((f) => [f.flag, f.flag.replace(/^--/, '--no-')])];
  const isMulti = (f: FieldSpec) => f.type === 'list' || f.type === 'map';
  const value = [
    ...(cmd.bodyFlags !== false ? ['--body', '--body-file'] : []),
    ...(bindsOrg(cmd) ? ['--org'] : []),
    ...fields.filter((f) => f.type !== 'boolean' && !isMulti(f)).map((f) => f.flag),
  ];
  const multi = fields.filter(isMulti).map((f) => f.flag);
  const { options, positionals } = parseOptions(rest, { bool, value, multi });
  if (options.help) {
    if (cmd.usageText !== undefined) write(ctx.io.stdout, cmd.usageText);
    else writeLine(ctx.io.stdout, `Usage: ${usageLine(group, cmd)}\n\n${cmd.summary}\nEndpoint: ${cmd.method} ${templates(cmd).join(' | ')}`);
    return 0;
  }

  const template = templates(cmd).find((p) => positionalNames(cmd, p).length === positionals.length);
  if (!template) { write(ctx.io.stderr, cmd.usageText ?? `Usage: ${usageLine(group, cmd)}\n`); return 2; }
  const path = fillPath(cmd, template, positionals, options.org);
  const requiredError = (f: FieldSpec) => new CliError(msg.required(f.flag, cmd.usageText ?? usageLine(group, cmd)), 2);

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
    if (v === undefined) { if (f.required) throw requiredError(f); continue; }
    const c = coerce(f, v, cmd, msg);
    if (f.type === 'csv') qs.set(f.key, (c as string[]).join(','));
    else if (Array.isArray(c)) c.forEach((x) => qs.append(f.key, String(x)));
    else qs.set(f.key, c !== null && typeof c === 'object' ? JSON.stringify(c) : String(c));
  }
  const url = qs.size ? `${path}${path.includes('?') ? '&' : '?'}${qs.toString()}` : path;

  const confirm = cmd.confirm ?? cmd.method === 'DELETE';
  const gate = () => { if (confirm && !options.yes) throw new CliError(msg.refusal(cmd.words, positionals), 2); };
  if (!cmd.validateFirst) gate();

  const isWrite = cmd.method !== 'GET' && cmd.method !== 'DELETE';
  const takesBody = isWrite || Boolean(cmd.body?.length) || cmd.bodyFlags === true;
  let explicit: Record<string, any> = {};
  const overlay: Record<string, any> = {};
  if (takesBody) {
    explicit = readBodyOptions(options, msg);
    for (const f of cmd.body ?? []) {
      const v = optionOf(f);
      if (v !== undefined) setPath(overlay, f.key, coerce(f, v, cmd, msg));
      else if (cmd.validateFirst && f.required && getPath(explicit, f.key) === undefined) throw requiredError(f);
    }
  }
  if (cmd.validateFirst) gate();

  let body: Record<string, any> | undefined;
  if (takesBody) {
    let base: Record<string, any> = {};
    if (cmd.rmw) {
      const from = fillPath(cmd, cmd.rmw.from ?? template, positionals, options.org);
      const current = await send(ctx, cmd, from, { method: 'GET' });
      const picked = cmd.rmw.pick ? cmd.rmw.pick(current.body) : current.body;
      base = picked && typeof picked === 'object' && !Array.isArray(picked) ? { ...picked } : {};
    }
    body = { ...structuredClone(cmd.fixed ?? {}), ...base, ...explicit };
    // Deep-apply each flag so a dotted key (`policy.roles`) edits inside a
    // read-modify-write base instead of replacing the whole sub-object.
    for (const f of cmd.body ?? []) {
      const v = getPath(overlay, f.key);
      if (v !== undefined) setPath(body, f.key, v);
    }
    if (!cmd.validateFirst) {
      for (const f of cmd.body ?? []) {
        if (f.required && getPath(body, f.key) === undefined) throw requiredError(f);
      }
    }
    if (!isWrite && Object.keys(body).length === 0) body = undefined;
    if (isWrite && body && Object.keys(body).length === 0 && cmd.emptyBody === false) body = undefined;
  }

  if (cmd.notice !== undefined) writeLine(ctx.io.stderr, cmd.notice);
  try {
    const res = await requestJson(ctx, url, { method: cmd.method, ...(body !== undefined ? { body } : {}), ...(cmd.anonymous ? { auth: false } : {}) });
    render(ctx, cmd, positionals, res.status, res.body);
    return 0;
  } catch (err) {
    if (err instanceof HttpError && cmd.bodyOnError?.includes(err.status)) {
      render(ctx, { ...cmd, method: 'GET' }, positionals, err.status, err.body);
      return 1;
    }
    if (err instanceof HttpError && cmd.hostErrors !== false) throw hostError(err);
    throw err;
  }
}

function getPath(obj: Record<string, any>, key: string): unknown {
  return key.split('.').reduce<any>((node, part) => (node && typeof node === 'object' ? node[part] : undefined), obj);
}

async function send(ctx: Ctx, cmd: RouteCmd, url: string, init: { method: string; body?: unknown }) {
  try {
    return await requestJson(ctx, url, { method: init.method, ...(init.body !== undefined ? { body: init.body } : {}), ...(cmd.anonymous ? { auth: false } : {}) });
  } catch (err) {
    if (err instanceof HttpError && cmd.hostErrors !== false) throw hostError(err);
    throw err;
  }
}

/** The rows of a list response: the body itself, `body[key]`, or (`anyArray`) its first array-valued field. */
function tableRows(table: NonNullable<RouteCmd['table']>, body: any): unknown {
  if (!table.anyArray) return table.key ? getPath(body ?? {}, table.key) : body;
  if (Array.isArray(body)) return body;
  const keyed = table.key ? getPath(body ?? {}, table.key) : undefined;
  if (Array.isArray(keyed)) return keyed;
  return Object.values(body ?? {}).find((v) => Array.isArray(v)) ?? [];
}

function render(ctx: Ctx, cmd: RouteCmd, positionals: string[], status: number, rawBody: any): void {
  const body = cmd.transform ? cmd.transform(rawBody) : rawBody;
  const noContent = body === null || body === undefined ? cmd.noContent : undefined;
  if (ctx.json) { writeJson(ctx.io.stdout, noContent !== undefined ? { ok: true, status } : body); return; }
  if (cmd.rawText && body && typeof body === 'object' && typeof body.raw === 'string' && Object.keys(body).length === 1) {
    write(ctx.io.stdout, body.raw.endsWith('\n') ? body.raw : `${body.raw}\n`);
    return;
  }
  if (noContent !== undefined) { writeLine(ctx.io.stdout, noContent.replace('{status}', String(status))); return; }
  if (cmd.human) { writeLine(ctx.io.stdout, cmd.human(body)); return; }
  if (cmd.table) {
    const rows = tableRows(cmd.table, body);
    if (rows === null || rows === undefined) { writeLine(ctx.io.stdout, cmd.table.empty ?? 'None.'); return; }
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
  if (cmd.method === 'GET' || cmd.writeOutput === 'json') { writeJson(ctx.io.stdout, body); return; }
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
