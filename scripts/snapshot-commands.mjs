#!/usr/bin/env node
/**
 * Behaviour snapshot of every command built on the command-table engine
 * (`src/cli/routeKit.ts`): the routeKit-native `RouteCmd[]` tables AND the
 * `resourceCommands` spec tables that adapt onto the same pipeline.
 *
 * The groups are ENUMERATED from source, never hand-listed: every
 * `src/cli/*.ts` that calls `runResourceGroup(ctx, '<group>', <HELP>, <SPECS>`
 * or `dispatchSpecs(ctx, '<group>', <SPECS>` contributes that spec array, and
 * every `runRouteGroup(ctx, '<group>', <HELP>, <ROUTES>` or
 * `dispatchRoutes(ctx, '<group>', <ROUTES>` contributes that route table. An
 * exported `CommandSpec[]` / `RouteCmd[]` that no call site dispatches is an
 * error, so a new table cannot silently escape the snapshot. For each command
 * the generator derives invocations from its declaration (dummy positionals,
 * every required flag, every optional flag with a type-appropriate dummy,
 * `--yes` / `--org`, `--json` and human variants, a blank value for every
 * number flag, double faults, and the common failure modes) and runs them
 * through `runCli` against a mock host, recording
 * {argv, requests (method, path+query, body), stdout, stderr, exit}. It also
 * records `openwop <group> --help` and `openwop <group> <sub> --help`.
 *
 *   node scripts/snapshot-commands.mjs            # rewrite test/fixtures/command-behaviour.json
 *   node scripts/snapshot-commands.mjs --check    # exit 1 when the live behaviour differs
 *
 * `test/command-behaviour-snapshot.test.mjs` regenerates and deep-equals the
 * fixture, so any change in what these commands send or print is a red test.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = join(ROOT, 'src/cli');
export const FIXTURE = join(ROOT, 'test/fixtures/command-behaviour.json');

/**
 * [{ kind, group, specsId, file }] for every command table a group dispatches,
 * read from source. `kind` is `spec` (a resourceCommands `CommandSpec[]`) or
 * `route` (a routeKit-native `RouteCmd[]`).
 */
function discoverGroups() {
  const out = [];
  const exporters = new Map();
  const composedOf = new Map(); // `export const X: T[] = [...A, ...B]` → X: [A, B]
  for (const file of readdirSync(CLI_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const src = readFileSync(join(CLI_DIR, file), 'utf8');
    for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*:\s*CommandSpec\[\]/g)) exporters.set(m[1], { file, kind: 'spec' });
    for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*:\s*RouteCmd\[\]/g)) exporters.set(m[1], { file, kind: 'route' });
    for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*:\s*(?:CommandSpec|RouteCmd)\[\]\s*=\s*\[((?:\s*\.\.\.[A-Za-z0-9_]+\s*,?)+)\]/g)) {
      composedOf.set(m[1], [...m[2].matchAll(/\.\.\.([A-Za-z0-9_]+)/g)].map((x) => x[1]));
    }
    for (const m of src.matchAll(/runResourceGroup\(\s*ctx,\s*'([^']+)',\s*[A-Za-z0-9_]+,\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2], via: 'spec' });
    for (const m of src.matchAll(/dispatchSpecs\(\s*ctx,\s*'([^']+)',\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2], via: 'spec' });
    for (const m of src.matchAll(/runRouteGroup\(\s*ctx,\s*'([^']+)',\s*[A-Za-z0-9_]+,\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2], via: 'route' });
    for (const m of src.matchAll(/dispatchRoutes\(\s*ctx,\s*'([^']+)',\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2], via: 'route' });
  }
  for (const g of out) {
    const ex = exporters.get(g.specsId);
    if (!ex || ex.kind !== g.via) throw new Error(`table ${g.specsId} (group ${g.group}) is not an exported ${g.via === 'spec' ? 'CommandSpec[]' : 'RouteCmd[]'}`);
    g.file = ex.file;
    g.kind = ex.kind;
    delete g.via;
  }
  // A table is covered when a group dispatches it, or it is spread into a covered one.
  const dispatched = new Set(out.map((g) => g.specsId));
  for (const id of [...dispatched]) for (const part of composedOf.get(id) ?? []) dispatched.add(part);
  const orphans = [...exporters.keys()].filter((id) => !dispatched.has(id));
  if (orphans.length) throw new Error(`exported command tables with no discovered call site: ${orphans.join(', ')}`);
  const names = out.map((g) => g.group);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`group ${dup} dispatches more than one table — key the snapshot by table`);
  return out.sort((a, b) => a.group.localeCompare(b.group));
}

/** Bundle src/cli.ts + the spec-exporting modules into one ESM file and import it. */
async function loadModules(groups, dir) {
  const { build } = await import('esbuild');
  const files = [...new Set(groups.map((g) => g.file))];
  const lines = [`export { runCli } from ${JSON.stringify(join(ROOT, 'src/cli.ts'))};`];
  files.forEach((f, i) => lines.push(`export * as m${i} from ${JSON.stringify(join(CLI_DIR, f))};`));
  const outfile = join(dir, 'bundle.mjs');
  await build({
    stdin: { contents: lines.join('\n'), resolveDir: ROOT, loader: 'ts', sourcefile: 'snapshot-entry.ts' },
    bundle: true, platform: 'node', target: 'node20', format: 'esm', outfile, packages: 'external', logLevel: 'silent',
    banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  });
  const mod = await import(pathToFileURL(outfile).href);
  const specsOf = (g) => mod[`m${files.indexOf(g.file)}`][g.specsId];
  return { runCli: mod.runCli, specsOf };
}

// ── declaration reading (mirrors the documented syntax, not the engine) ─────

function specField(spec) {
  let s = spec;
  let flagOverride;
  const eq = s.indexOf('=');
  if (eq !== -1) { flagOverride = s.slice(eq + 1); s = s.slice(0, eq); }
  const required = s.endsWith('!');
  if (required) s = s.slice(0, -1);
  const [key = '', type = 'string'] = s.split(':');
  const flag = `--${flagOverride ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, '-')}`;
  // The spec syntax's `list` is one comma-separated value (routeKit's `csv`).
  return { key, flag, type: type === 'list' ? 'csv' : type, required };
}
const hasOrg = (route) => /:org(?![A-Za-z0-9_])/.test(route);
const paramNames = (route) => (route.match(/:[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((p) => p.slice(1));

/**
 * One normalized descriptor per command, whatever its declaration syntax:
 * { key, words, method, templates: [[positional names]], org, fields, body
 * ('accepted' | 'rejected' | 'ignored'), confirm, list, text, rmwKey, bodyOnError }.
 */
function describeSpec(spec) {
  return {
    key: `${spec.method} ${spec.cmd.join(' ')} ${spec.route}`,
    words: spec.cmd,
    method: spec.method,
    templates: [paramNames(spec.route).filter((p) => p !== 'org')],
    org: hasOrg(spec.route),
    fields: [...(spec.query ?? []), ...(spec.body ?? [])].map(specField),
    bodyFields: (spec.body ?? []).map(specField),
    body: spec.body || spec.rawBody ? 'accepted' : 'rejected',
    confirm: Boolean(spec.confirm),
    list: spec.list,
    text: Boolean(spec.text),
    rmwKey: spec.rmwKey,
    bodyOnError: [],
  };
}

const routeField = (f) => ({ key: f.key, flag: f.flag, type: f.type ?? 'string', required: Boolean(f.required) });

function describeRoute(cmd) {
  const paths = Array.isArray(cmd.path) ? cmd.path : [cmd.path];
  const isWrite = cmd.method !== 'GET' && cmd.method !== 'DELETE';
  const takesBody = isWrite || Boolean(cmd.body?.length) || cmd.bodyFlags === true;
  const org = Boolean(cmd.orgFlag) && paths.some((p) => paramNames(p).includes('org'));
  return {
    key: `${cmd.method} ${cmd.words.join(' ')} ${paths.join(' | ')}`,
    words: cmd.words,
    method: cmd.method,
    templates: paths.map((p) => paramNames(p).filter((n) => !(cmd.orgFlag && n === 'org'))),
    org,
    fields: [...(cmd.query ?? []), ...(cmd.body ?? [])].map(routeField),
    bodyFields: (cmd.body ?? []).map(routeField),
    body: cmd.bodyFlags === false ? 'rejected' : takesBody ? 'accepted' : 'ignored',
    confirm: cmd.confirm ?? cmd.method === 'DELETE',
    list: cmd.table ? { key: cmd.table.key, columns: cmd.table.columns } : undefined,
    text: Boolean(cmd.rawText),
    rmwKey: undefined,
    bodyOnError: cmd.bodyOnError ?? [],
  };
}

/** The argv tokens that set field `f` to a type-appropriate dummy (`bool`: 'true' | 'false'). */
function dummy(f, fileFor, bool = 'true') {
  switch (f.type) {
    case 'number': return [f.flag, '42'];
    case 'boolean': return [bool === 'true' ? f.flag : f.flag.replace(/^--/, '--no-')];
    case 'bool': return [f.flag, bool];
    case 'json': return [f.flag, '{"k":"v"}'];
    case 'csv': return [f.flag, 'a, b,,c'];
    case 'list': return [f.flag, 'a', f.flag, 'b'];
    case 'map': return [f.flag, 'k=v', f.flag, 'n=3'];
    case 'file': case 'file64': return [f.flag, fileFor(f)];
    case 'json-file': return [f.flag, fileFor({ key: f.key, json: '{"fromJsonFile":true}' })];
    default: return [f.flag, `${f.key}-val`];
  }
}

// ── the mock host ────────────────────────────────────────────────────────────

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function rowFor(columns, n) {
  const row = {};
  columns.forEach((c, i) => { row[c] = n === 1 ? (i % 3 === 0 ? `${c}-${n}` : i % 3 === 1 ? 7 : { n }) : (i % 2 === 0 ? null : `${c}-${n}`); });
  return row;
}

/** Response for a request, by variant mode. The descriptor only shapes the canned data. */
function respond(spec, mode, req) {
  // Capability probes (`ensureAdvertised`): answer "cannot prove absence" so the
  // guarded groups reach their declared commands.
  if (req.url.pathname === '/.well-known/openwop') return jsonRes({ error: 'not_found' }, 404);
  if (mode === 'null') return new Response(null, { status: 204 });
  if (mode === 'err404') return jsonRes({ error: 'not_found', message: 'No such thing.' }, 404);
  if (mode === 'err401') return jsonRes({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  if (mode === 'err403') return jsonRes({ error: 'forbidden', message: 'Nope.' }, 403);
  if (mode === 'err500') return jsonRes({ error: 'internal', message: 'Boom.' }, 500);
  if (mode === 'raw') return new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv' } });
  if (mode === 'listkey-miss') return jsonRes({ total: 2, other: [rowFor(spec.list?.columns ?? ['id'], 1)] });
  if (mode === 'array') return jsonRes([rowFor(spec.list?.columns ?? ['id'], 1)]);
  if (mode.startsWith('status')) return jsonRes({ status: 'degraded', checks: [{ id: 'db', ok: false }] }, Number(mode.slice(6)));
  const columns = spec.list?.columns ?? ['id', 'name'];
  const rows = mode === 'empty' ? [] : [rowFor(columns, 1), rowFor(columns, 2)];
  if (req.method === 'GET') {
    const body = { id: 'g1', base: 'top', keep: 1, [spec.list?.key ?? 'items']: rows };
    if (spec.rmwKey) body[spec.rmwKey] = { base: 'nested', keep: 2 };
    return jsonRes(body);
  }
  return jsonRes({ ok: true, id: 'w1' }, req.method === 'POST' ? 201 : 200);
}

// ── invocations ──────────────────────────────────────────────────────────────

function invocations(group, d, fileFor) {
  const all = d.fields;
  const pos = (d.templates[0] ?? []).map((p) => `${p}/1`);
  const org = d.org ? ['--org', 'o/1'] : [];
  const yes = d.confirm ? ['--yes'] : [];
  const req = all.filter((f) => f.required).flatMap((f) => dummy(f, fileFor));
  const opt = (bool) => all.filter((f) => !f.required).flatMap((f) => dummy(f, fileFor, bool));
  const base = [group, ...d.words, ...pos];
  const v = [];
  const add = (name, argv, mode = 'ok') => v.push({ name, argv, mode });
  const isBool = (f) => f.type === 'bool' || f.type === 'boolean';

  add('min', [...base, ...org, ...req, ...yes]);
  add('min-json', ['--json', ...base, ...org, ...req, ...yes]);
  add('full', [...base, ...org, ...req, ...opt('true'), ...yes]);
  add('full-json', ['--json', ...base, ...org, ...req, ...opt('true'), ...yes]);
  if (all.some((f) => isBool(f) && !f.required)) {
    add('full-false', [...base, ...org, ...req, ...opt('false'), ...yes]);
    if (all.some((f) => f.type === 'bool')) add('bool-no', [...base, ...org, ...req, ...all.filter((f) => f.type === 'bool').flatMap((f) => [f.flag, 'no']), ...yes]);
  }
  if (d.body === 'accepted') {
    add('body', [...base, ...org, ...req, '--body', '{"extra":1,"keep":"body"}', ...yes]);
    add('body-only', [...base, ...org, '--body', JSON.stringify(Object.fromEntries(d.bodyFields.map((f) => [f.key, 'from-body']))), ...yes]);
    add('body-file', [...base, ...org, ...req, '--body-file', fileFor({ key: '__body', json: '{"fromFile":true}' }), ...yes]);
    add('body-bad', [...base, ...org, ...req, '--body', '[1]', ...yes]);
  } else if (d.body === 'rejected') {
    add('body-rejected', [...base, ...org, ...req, '--body', '{}', ...yes]);
  } else {
    add('body-ignored', [...base, ...org, ...req, '--body', '{}', ...yes]);
  }
  add('null', [...base, ...org, ...req, ...yes], 'null');
  add('null-json', ['--json', ...base, ...org, ...req, ...yes], 'null');
  add('err404', [...base, ...org, ...req, ...yes], 'err404');
  if (d.list) {
    add('list-empty', [...base, ...org, ...req, ...yes], 'empty');
    add('list-key-miss', [...base, ...org, ...req, ...yes], 'listkey-miss');
    add('list-array', [...base, ...org, ...req, ...yes], 'array');
  }
  if (d.text) {
    add('text', [...base, ...org, ...req, ...yes], 'raw');
    add('text-json', ['--json', ...base, ...org, ...req, ...yes], 'raw');
  }
  if (d.confirm) add('no-yes', [...base, ...org, ...req]);
  // Double faults pin which check wins (e.g. input validation vs the --yes gate).
  if (d.confirm && all.some((f) => f.required)) add('no-yes+missing', [...base, ...org]);
  if (d.confirm && all.some((f) => f.type === 'number' || f.type === 'json')) {
    const f = all.find((x) => x.type === 'number' || x.type === 'json');
    add('no-yes+bad', [...base, ...org, ...req, f.flag, f.type === 'number' ? 'abc' : '{nope']);
  }
  if (d.confirm && org.length) add('no-yes+no-org', [...base, ...req]);
  if (org.length) add('no-org', [...base, ...req, ...yes]);
  if (pos.length) add('missing-positional', [...base.slice(0, -1), ...org, ...req, ...yes]);
  add('extra-positional', [...base, 'extra', ...org, ...req, ...yes]);
  for (const f of all.filter((x) => x.required)) {
    add(`missing ${f.flag}`, [...base, ...org, ...all.filter((x) => x.required && x !== f).flatMap((x) => dummy(x, fileFor)), ...yes]);
  }
  const bad = { number: 'abc', bool: 'maybe', json: '{nope', file: '/nonexistent/openwop-snapshot', file64: '/nonexistent/openwop-snapshot', 'json-file': '/nonexistent/openwop-snapshot', map: 'novalue' };
  for (const f of all) {
    if (bad[f.type] && !v.some((x) => x.name === `bad ${f.type}`)) {
      const rest = all.filter((x) => x.required && x !== f).flatMap((x) => dummy(x, fileFor));
      add(`bad ${f.type}`, [...base, ...org, ...rest, f.flag, bad[f.type], ...yes]);
    }
  }
  const numbers = all.filter((x) => x.type === 'number');
  const blank = (f) => [...base, ...org, ...all.filter((x) => x.required && x !== f).flatMap((x) => dummy(x, fileFor)), `${f.flag}=`, ...yes];
  if (numbers.length) add('blank number', blank(numbers[0]));
  add('sub-help', [...base, '--help']);
  // ── additions (2026-09, engine convergence): appended so every row above
  // keeps its position. A blank value for EVERY number flag (human + --json),
  // double faults without a --yes gate, alternate path templates, and the
  // readiness-style statuses that still carry a body.
  for (const f of numbers.slice(1)) add(`blank ${f.flag}`, blank(f));
  for (const f of numbers) add(`blank ${f.flag} json`, ['--json', ...blank(f)]);
  const badF = all.find((x) => x.type === 'number' || x.type === 'json');
  if (badF && all.some((x) => x.required && x !== badF)) {
    add('missing+bad', [...base, ...org, badF.flag, badF.type === 'number' ? 'abc' : '{nope', ...yes]);
  }
  if (numbers.length && d.body === 'accepted') add('blank-number+body-bad', [...base, ...org, ...req, `${numbers[0].flag}=`, '--body', '[1]', ...yes]);
  d.templates.slice(1).forEach((names, i) => {
    add(`template#${i + 1}`, [group, ...d.words, ...names.map((p) => `${p}/1`), ...org, ...req, ...yes]);
    add(`template#${i + 1}-json`, ['--json', group, ...d.words, ...names.map((p) => `${p}/1`), ...org, ...req, ...yes]);
  });
  for (const status of d.bodyOnError) {
    add(`status ${status}`, [...base, ...org, ...req, ...yes], `status${status}`);
    add(`status ${status} json`, ['--json', ...base, ...org, ...req, ...yes], `status${status}`);
  }
  return v;
}

// ── run ──────────────────────────────────────────────────────────────────────

export async function generateSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'openwop-snapshot-'));
  try {
    const groups = discoverGroups();
    const { runCli, specsOf } = await loadModules(groups, dir);
    // Named by content, not by call order, so adding a variant never renames
    // the files every later invocation's argv records.
    const files = new Map();
    const fileFor = (f) => {
      const content = f.json ?? `${f.key}-secret\n`;
      const path = join(dir, `${f.key}${f.json ? '.json' : '.txt'}`);
      if (files.has(path) && files.get(path) !== content) throw new Error(`snapshot file ${path}: conflicting contents`);
      if (!files.has(path)) { files.set(path, content); writeFileSync(path, content); }
      return path;
    };
    const norm = (s) => s.split(dir).join('<TMP>');
    const env = { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1', OPENWOP_BASE_URL: 'http://mock.test', OPENWOP_CONFIG_HOME: dir };

    async function run(argv, spec, mode) {
      let stdout = '';
      let stderr = '';
      const requests = [];
      const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method ?? 'GET';
        requests.push({
          method,
          url: `${u.pathname}${u.search}`,
          auth: Boolean(init.headers?.authorization),
          ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}),
        });
        return respond(spec ?? {}, mode, { method, url: u });
      };
      const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
      const exit = await runCli(argv, { io, fetchImpl, cwd: ROOT, repoRoot: ROOT, env });
      return { argv: argv.map(norm), requests, stdout: norm(stdout), stderr: norm(stderr), exit };
    }

    const result = { groups: {}, commandCount: 0, helpCount: 0, invocationCount: 0 };
    for (const g of groups) {
      const specs = specsOf(g).map((c) => (g.kind === 'spec' ? describeSpec(c) : describeRoute(c)));
      const entry = { ...(g.kind === 'route' ? { kind: 'route' } : {}), specsId: g.specsId, help: await run([g.group, '--help']), commands: {} };
      result.helpCount++;
      for (const spec of specs) {
        const key = spec.key;
        if (entry.commands[key]) throw new Error(`${g.group}: duplicate command key ${key}`);
        const rows = [];
        for (const inv of invocations(g.group, spec, fileFor)) {
          const r = await run(inv.argv, spec, inv.mode);
          rows.push({ variant: inv.name, mode: inv.mode, ...r });
          result.invocationCount++;
          if (inv.name === 'sub-help') result.helpCount++;
        }
        entry.commands[key] = rows;
        result.commandCount++;
      }
      // Group-level failure modes: unknown subcommand + auth/server errors on the first command.
      const first = specs[0];
      const inv = invocations(g.group, first, fileFor)[0];
      entry.groupErrors = {
        unknown: await run([g.group, 'no-such-sub', 'x']),
        err401: await run(inv.argv, first, 'err401'),
        err403: await run(inv.argv, first, 'err403'),
        err500: await run(inv.argv, first, 'err500'),
      };
      result.groups[g.group] = entry;
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pretty JSON with one line per recorded invocation (small, diff-friendly). */
export function serialize(snap) {
  const text = JSON.stringify(snap, (_k, v) => (v && typeof v === 'object' && 'exit' in v ? `\u0000${JSON.stringify(v)}` : v), 1);
  return `${text.replace(/"\\u0000(.*)"/g, (m) => JSON.parse(m).slice(1))}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snap = await generateSnapshot();
  if (process.argv.includes('--check')) {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const same = isDeepStrictEqual(snap, fixture);
    process.stdout.write(same ? 'snapshot matches\n' : 'snapshot DIFFERS\n');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(FIXTURE, serialize(snap));
  process.stdout.write(`wrote ${FIXTURE}: ${snap.commandCount} commands, ${snap.helpCount} help texts, ${snap.invocationCount} invocations\n`);
}
