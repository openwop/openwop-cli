import type { Ctx } from '../context.js';
/**
 * Declarative resource-command table — the shared engine behind the
 * commerce/sales host-extension groups (commerce, commerce-connect, promotions,
 * recommendations, dealers, commissions, territories, sales-maps, and the crm
 * extensions). Those surfaces are wide (≈240 routes) and uniform: a verb, a
 * route template, some query flags, some body fields. Writing each one by hand
 * would be ~40 lines of identical plumbing per route, so a group instead
 * declares a `CommandSpec[]` and hands it to `runResourceGroup`.
 *
 * The engine only relays: it builds the path (every param URL-encoded), the
 * query string, and the JSON body from flags + `--body`/`--body-file`, then
 * renders the host's response verbatim (`--json`) or as a table / pretty JSON.
 * It never computes a policy, a price, or a total — money fields are passed
 * through in the host's own minor units, exactly as given.
 */
import { readFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A field spec: `key[:type][!]`. The flag is the kebab-case of `key`
 * (`priceMinor` → `--price-minor`). Types: `string` (default), `number`
 * (finite, e.g. minor units), `bool` (`true`/`false`), `json` (parsed JSON),
 * `list` (comma-separated → string[]). A trailing `!` marks it required
 * (satisfied either by the flag or by the same key inside `--body`).
 * An optional `=flag-name` suffix overrides the flag name
 * (`client_id=client-id`).
 */
export type FieldSpec = string;

export interface CommandSpec {
  /** Subcommand words after the group name, e.g. `['products', 'list']`. */
  cmd: string[];
  method: HttpMethod;
  /**
   * Route template. `:org` binds to `--org` (required); every other `:param`
   * binds to a positional, in order. Every value is `encodeURIComponent`-ed.
   */
  route: string;
  summary: string;
  query?: FieldSpec[];
  body?: FieldSpec[];
  /** Accept a free-form `--body <json>` / `--body-file <path>` (implied by `body`). */
  rawBody?: boolean;
  /** Destructive: refuse without `--yes`. */
  confirm?: boolean;
  /** Send without the bearer (public/anonymous visitor routes). */
  auth?: boolean;
  /**
   * Read-modify-write: GET this route (same params) first, merge the flags
   * over the current value, then send — for routes that REPLACE on write.
   * `rmwKey` picks a nested object out of the GET response.
   */
  rmw?: string;
  rmwKey?: string;
  /** Human rendering of a list response. */
  list?: { key?: string; columns: string[]; empty?: string };
  /** Response is text (CSV) — human mode writes it verbatim. */
  text?: boolean;
  /** Extra notice printed to stderr before the request (e.g. a secret-reveal warning). */
  notice?: string;
}

interface ParsedField { key: string; flag: string; type: string; required: boolean }

function parseField(spec: FieldSpec): ParsedField {
  let s = spec;
  let flagOverride: string | undefined;
  const eq = s.indexOf('=');
  if (eq !== -1) { flagOverride = s.slice(eq + 1); s = s.slice(0, eq); }
  const required = s.endsWith('!');
  if (required) s = s.slice(0, -1);
  const [key = '', type = 'string'] = s.split(':');
  const flag = `--${flagOverride ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, '-')}`;
  return { key, flag, type, required };
}

function coerce(field: ParsedField, raw: string): unknown {
  switch (field.type) {
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) throw new CliError(`${field.flag} must be a number, got: ${raw}`);
      return n;
    }
    case 'bool':
      if (raw === 'true' || raw === 'yes' || raw === '1') return true;
      if (raw === 'false' || raw === 'no' || raw === '0') return false;
      throw new CliError(`${field.flag} must be true or false, got: ${raw}`);
    case 'json':
      try { return JSON.parse(raw); } catch { throw new CliError(`${field.flag} must be valid JSON`); }
    case 'list':
      return raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
    default:
      return raw;
  }
}

function paramsOf(route: string): string[] {
  return (route.match(/:[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((p) => p.slice(1)).filter((p) => p !== 'org');
}

/** The one-line usage for a command (also used by the generated group help). */
export function usageLine(group: string, spec: CommandSpec): string {
  const parts = [`openwop ${group}`, ...spec.cmd, ...paramsOf(spec.route).map((p) => `<${p}>`)];
  if (spec.route.includes(':org')) parts.push('--org <orgId>');
  const fmt = (f: ParsedField) => {
    const v = f.type === 'bool' ? 'true|false' : f.type === 'json' ? 'json' : f.type === 'list' ? 'a,b' : f.type === 'number' ? 'n' : 'v';
    return f.required ? `${f.flag} <${v}>` : `[${f.flag} <${v}>]`;
  };
  for (const f of (spec.query ?? []).map(parseField)) parts.push(fmt(f));
  for (const f of (spec.body ?? []).map(parseField)) parts.push(fmt(f));
  if (spec.body || spec.rawBody) parts.push('[--body <json> | --body-file <path>]');
  if (spec.confirm) parts.push('--yes');
  parts.push('[--json]');
  return parts.join(' ');
}

/** Generated help: prose + one usage/route/summary block per command + footer. */
export function buildGroupHelp(group: string, intro: string, specs: CommandSpec[], footer = ''): string {
  const lines = ['Usage:'];
  for (const s of specs) {
    lines.push(`  ${usageLine(group, s)}`);
    lines.push(`      ${s.method} ${s.route}${s.auth === false ? '  (public, no auth)' : ''} — ${s.summary}`);
  }
  return `${lines.join('\n')}\n\n${intro.trim()}\n\nFlags take the host's field names in kebab-case (priceMinor → --price-minor).
Money amounts are passed through exactly, in the unit the host's field names
(e.g. priceMinor = cents, priceMajorUnits = whole units); the CLI never
computes a price or a total. \`--body\`/\`--body-file\` supply the
full JSON body; individual flags override keys in it.

Exit codes: 0 ok · 2 usage error / request rejected · 4 not signed in or not
permitted (HTTP 401/403) · 1 server error.
${footer ? `\n${footer.trim()}\n` : ''}`;
}

function matchSpec(specs: CommandSpec[], argv: string[]): { spec: CommandSpec; rest: string[] } | null {
  let best: { spec: CommandSpec; rest: string[] } | null = null;
  for (const spec of specs) {
    if (spec.cmd.length > argv.length) continue;
    if (spec.cmd.every((w, i) => argv[i] === w) && (!best || spec.cmd.length > best.spec.cmd.length)) {
      best = { spec, rest: argv.slice(spec.cmd.length) };
    }
  }
  return best;
}

function readBodyOption(options: Record<string, any>): Record<string, unknown> {
  let raw: string | undefined;
  if (options.bodyFile) {
    try { raw = readFileSync(String(options.bodyFile), 'utf8'); } catch { throw new CliError(`Cannot read --body-file ${options.bodyFile}`); }
  } else if (options.body !== undefined) {
    raw = String(options.body);
  }
  if (raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError('--body/--body-file must be valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('--body/--body-file must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** Execute one resolved command spec. Exported for groups that wrap a spec. */
export async function runSpec(ctx: Ctx, group: string, spec: CommandSpec, argv: string[]): Promise<number> {
  const queryFields = (spec.query ?? []).map(parseField);
  const bodyFields = (spec.body ?? []).map(parseField);
  const allowBody = Boolean(spec.body || spec.rawBody);
  const valueFlags = [...queryFields, ...bodyFields].map((f) => f.flag);
  if (spec.route.includes(':org')) valueFlags.push('--org');
  if (allowBody) valueFlags.push('--body', '--body-file');
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'], value: valueFlags });
  const usage = `Usage: ${usageLine(group, spec)}\n  ${spec.method} ${spec.route} — ${spec.summary}\n`;
  if (options.help) { write(ctx.io.stdout, usage); return 0; }
  const params = paramsOf(spec.route);
  if (positionals.length !== params.length) { write(ctx.io.stderr, usage); return 2; }

  const optionValue = (f: ParsedField) => options[f.flag.slice(2).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())];
  const fill = (route: string) => {
    let i = 0;
    return route.replace(/:[A-Za-z][A-Za-z0-9_]*/g, (m) => {
      if (m === ':org') return encodeURIComponent(requireOrg(options.org));
      return encodeURIComponent(positionals[i++] ?? '');
    });
  };
  let path = fill(spec.route);

  const qs = new URLSearchParams();
  for (const f of queryFields) {
    const v = optionValue(f);
    if (v === undefined) {
      if (f.required) throw new CliError(`${f.flag} is required.\n${usage}`);
      continue;
    }
    const c = coerce(f, String(v));
    qs.set(f.key, Array.isArray(c) ? c.join(',') : typeof c === 'object' ? JSON.stringify(c) : String(c));
  }
  const q = qs.toString();
  if (q) path += `?${q}`;

  let body: Record<string, unknown> | undefined;
  if (allowBody || spec.method === 'POST' || spec.method === 'PUT' || spec.method === 'PATCH') {
    body = allowBody ? readBodyOption(options) : {};
    for (const f of bodyFields) {
      const v = optionValue(f);
      if (v !== undefined) body[f.key] = coerce(f, String(v));
      else if (f.required && body[f.key] === undefined) throw new CliError(`${f.flag} is required.\n${usage}`);
    }
    if (spec.method === 'DELETE' && Object.keys(body).length === 0) body = undefined;
  }

  if (spec.confirm && !options.yes) {
    throw new CliError(`Refusing to ${spec.summary.charAt(0).toLowerCase()}${spec.summary.slice(1).replace(/\.$/, '')} without --yes.`, 2);
  }

  if (spec.rmw) {
    const current = await requestJson(ctx, fill(spec.rmw), { auth: spec.auth });
    const base = spec.rmwKey ? current.body?.[spec.rmwKey] : current.body;
    body = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}), ...(body ?? {}) };
  }

  if (spec.notice) writeLine(ctx.io.stderr, spec.notice);
  const res = await requestJson(ctx, path, {
    method: spec.method,
    ...(body !== undefined ? { body } : {}),
    ...(spec.auth === false ? { auth: false } : {}),
  });
  return render(ctx, spec, res.status, res.body);
}

function render(ctx: Ctx, spec: CommandSpec, status: number, body: any): number {
  if (ctx.json) {
    writeJson(ctx.io.stdout, body ?? { ok: true, status });
    return 0;
  }
  if (body && typeof body === 'object' && typeof body.raw === 'string' && Object.keys(body).length === 1) {
    write(ctx.io.stdout, body.raw.endsWith('\n') ? body.raw : `${body.raw}\n`);
    return 0;
  }
  if (body === null || body === undefined) {
    writeLine(ctx.io.stdout, spec.method === 'DELETE' ? 'Deleted.' : `Done (HTTP ${status}).`);
    return 0;
  }
  if (spec.list) {
    const items = Array.isArray(body)
      ? body
      : spec.list.key && Array.isArray(body?.[spec.list.key])
        ? body[spec.list.key]
        : (Object.values(body ?? {}).find((v) => Array.isArray(v)) as any[] | undefined) ?? [];
    if (items.length === 0) { writeLine(ctx.io.stdout, spec.list.empty ?? 'None.'); return 0; }
    writeLine(ctx.io.stdout, formatTable(items.map((row: any) => {
      const out: Record<string, string> = {};
      for (const col of spec.list!.columns) {
        const v = row?.[col];
        out[col] = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      return out;
    }), spec.list.columns));
    return 0;
  }
  writeJson(ctx.io.stdout, body);
  return 0;
}

/** Dispatch `argv` against a group's spec table (`--help` / no args → help). */
export async function runResourceGroup(ctx: Ctx, group: string, help: string, specs: CommandSpec[], argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    write(ctx.io.stdout, help);
    return 0;
  }
  const match = matchSpec(specs, argv);
  if (!match) {
    throw new CliError(`Unknown ${group} command: ${argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')}\nRun \`openwop ${group} --help\` for usage.`);
  }
  return runSpec(ctx, group, match.spec, match.rest);
}
