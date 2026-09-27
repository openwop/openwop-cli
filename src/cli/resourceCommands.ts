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
 *
 * This module is only the concise DECLARATION syntax + its help renderer.
 * Execution is routeKit's one pipeline: `toRouteCmd` translates a spec into a
 * `RouteCmd`, setting every behaviour this syntax promises explicitly (the
 * `:org` binding, valued booleans, `--body` acceptance, the `--yes` gate,
 * rendering, error pass-through, messages), and `runRoute` executes it. The
 * group behaviour is pinned by test/command-behaviour-snapshot.test.mjs.
 */
import { CliError } from '../errors.js';
import { write } from '../io.js';
import { matchRoute, runRoute, type FieldType, type FieldSpec as RouteField, type RouteCmd } from './routeKit.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A field spec: `key[:type][!]`. The flag is the kebab-case of `key`
 * (`priceMinor` → `--price-minor`). Types: `string` (default), `number`
 * (finite, e.g. minor units), `bool` (`true`/`false`), `json` (parsed JSON),
 * `list` (comma-separated → string[]), `file` (a local file's text — for a
 * secret the user supplies, so it never lands in shell history; one trailing
 * newline dropped). A trailing `!` marks it required
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

/** True when the route binds `:org` exactly (not `:orgId`). */
function hasOrg(route: string): boolean {
  return /:org(?![A-Za-z0-9_])/.test(route);
}

function paramsOf(route: string): string[] {
  return (route.match(/:[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((p) => p.slice(1)).filter((p) => p !== 'org');
}

/** The one-line usage for a command (also used by the generated group help). */
export function usageLine(group: string, spec: CommandSpec): string {
  const parts = [`openwop ${group}`, ...spec.cmd, ...paramsOf(spec.route).map((p) => `<${p}>`)];
  if (hasOrg(spec.route)) parts.push('--org <orgId>');
  const fmt = (f: ParsedField) => {
    const v = f.type === 'bool' ? 'true|false' : f.type === 'json' ? 'json' : f.type === 'list' ? 'a,b' : f.type === 'number' ? 'n' : f.type === 'file' ? 'path' : 'v';
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

const TYPES: Record<string, FieldType> = { string: 'string', number: 'number', bool: 'bool', json: 'json', list: 'csv', file: 'file' };

function toField(spec: FieldSpec): RouteField {
  const f = parseField(spec);
  // An unrecognised type has always been read as a plain string.
  return { flag: f.flag, key: f.key, type: TYPES[f.type] ?? 'string', required: f.required };
}

/** Translate a spec into routeKit's command shape — every default set explicitly. */
export function toRouteCmd(group: string, spec: CommandSpec): RouteCmd {
  const usage = `Usage: ${usageLine(group, spec)}\n  ${spec.method} ${spec.route} — ${spec.summary}\n`;
  const rmwKey = spec.rmwKey;
  return {
    words: spec.cmd,
    method: spec.method,
    path: spec.route,
    summary: spec.summary,
    query: (spec.query ?? []).map(toField),
    body: (spec.body ?? []).map(toField),
    orgFlag: true,
    bodyFlags: Boolean(spec.body || spec.rawBody),
    emptyBody: true,
    confirm: Boolean(spec.confirm),
    anonymous: spec.auth === false,
    ...(spec.list ? { table: { key: spec.list.key, columns: spec.list.columns, empty: spec.list.empty ?? 'None.', anyArray: true } } : {}),
    ...(spec.rmw ? { rmw: { from: spec.rmw, pick: (body: any) => (rmwKey ? body?.[rmwKey] : body) } } : {}),
    ...(spec.notice !== undefined ? { notice: spec.notice } : {}),
    rawText: true, // every spec, as before — `text` only documents the route
    noContent: spec.method === 'DELETE' ? 'Deleted.' : 'Done (HTTP {status}).',
    writeOutput: 'json',
    hostErrors: false,
    validateFirst: true,
    usageText: usage,
    messages: {
      required: (flag, usageText) => `${flag} is required.\n${usageText}`,
      refusal: () => `Refusing to ${spec.summary.charAt(0).toLowerCase()}${spec.summary.slice(1).replace(/\.$/, '')} without --yes.`,
      invalidNumber: (flag, raw) => `${flag} must be a number, got: ${raw}`,
      invalidBool: (flag, raw) => `${flag} must be true or false, got: ${raw}`,
      invalidJson: (flag) => `${flag} must be valid JSON`,
      unreadable: (flag, path) => `Cannot read ${flag} ${path}`,
      unreadableBody: (path) => `Cannot read --body-file ${path}`,
      invalidBodyJson: '--body/--body-file must be valid JSON',
      bodyNotObject: '--body/--body-file must be a JSON object',
    },
  };
}

function matchSpec(specs: CommandSpec[], argv: string[]): CommandSpec | undefined {
  return matchRoute(specs.map((spec) => ({ words: spec.cmd, spec })), argv)?.spec;
}

/** Execute one resolved command spec (`argv` excludes the spec's words) on routeKit's runner. */
async function runSpec(ctx: Ctx, group: string, spec: CommandSpec, argv: string[]): Promise<number> {
  return runRoute(ctx, group, toRouteCmd(group, spec), [...spec.cmd, ...argv]);
}

/**
 * Run the spec matching `argv` when there is one, else `undefined` — for a
 * hand-written group that serves part of its surface from a spec table and
 * falls through to its own switch for the rest.
 */
export async function dispatchSpecs(ctx: Ctx, group: string, specs: CommandSpec[], argv: string[]): Promise<number | undefined> {
  const spec = matchSpec(specs, argv);
  return spec ? runSpec(ctx, group, spec, argv.slice(spec.cmd.length)) : undefined;
}

/** One usage + route line per spec — the generated block a hand-written group appends to its help. */
export function specsUsage(group: string, specs: CommandSpec[]): string {
  return specs.map((s) => `  ${usageLine(group, s)}\n      ${s.method} ${s.route}${s.auth === false ? '  (public, no auth)' : ''} — ${s.summary}`).join('\n');
}

/** Dispatch `argv` against a group's spec table (`--help` / no args → help). */
export async function runResourceGroup(ctx: Ctx, group: string, help: string, specs: CommandSpec[], argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    write(ctx.io.stdout, help);
    return 0;
  }
  const spec = matchSpec(specs, argv);
  if (!spec) {
    throw new CliError(`Unknown ${group} command: ${argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')}\nRun \`openwop ${group} --help\` for usage.`);
  }
  return runSpec(ctx, group, spec, argv.slice(spec.cmd.length));
}
