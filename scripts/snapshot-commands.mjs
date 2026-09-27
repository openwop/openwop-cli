#!/usr/bin/env node
/**
 * Behaviour snapshot of every command built on the declarative spec-table
 * engine (`src/cli/resourceCommands.ts`).
 *
 * The groups are ENUMERATED from source, never hand-listed: every
 * `src/cli/*.ts` that calls `runResourceGroup(ctx, '<group>', <HELP>, <SPECS>`
 * or `dispatchSpecs(ctx, '<group>', <SPECS>` contributes that spec array. For
 * each spec the generator derives invocations from the spec itself (dummy
 * positionals, every required flag, every optional flag with a type-appropriate
 * dummy, `--yes` / `--org`, `--json` and human variants, and the common failure
 * modes) and runs them through `runCli` against a mock host, recording
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

/** [{ group, specsId }] for every spec table a group dispatches, read from source. */
function discoverGroups() {
  const out = [];
  const exporters = new Map();
  for (const file of readdirSync(CLI_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const src = readFileSync(join(CLI_DIR, file), 'utf8');
    for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*:\s*CommandSpec\[\]/g)) exporters.set(m[1], file);
    for (const m of src.matchAll(/runResourceGroup\(\s*ctx,\s*'([^']+)',\s*[A-Za-z0-9_]+,\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2] });
    for (const m of src.matchAll(/dispatchSpecs\(\s*ctx,\s*'([^']+)',\s*([A-Z0-9_]+)/g)) out.push({ group: m[1], specsId: m[2] });
  }
  for (const g of out) {
    g.file = exporters.get(g.specsId);
    if (!g.file) throw new Error(`spec table ${g.specsId} (group ${g.group}) is not an exported CommandSpec[]`);
  }
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

// ── spec reading (mirrors the documented spec syntax, not the engine) ────────

function field(spec) {
  let s = spec;
  let flagOverride;
  const eq = s.indexOf('=');
  if (eq !== -1) { flagOverride = s.slice(eq + 1); s = s.slice(0, eq); }
  const required = s.endsWith('!');
  if (required) s = s.slice(0, -1);
  const [key = '', type = 'string'] = s.split(':');
  const flag = `--${flagOverride ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, '-')}`;
  return { key, flag, type, required };
}
const hasOrg = (route) => /:org(?![A-Za-z0-9_])/.test(route);
const params = (route) => (route.match(/:[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((p) => p.slice(1)).filter((p) => p !== 'org');

function dummy(f, fileFor, bool = 'true') {
  switch (f.type) {
    case 'number': return '42';
    case 'bool': return bool;
    case 'json': return '{"k":"v"}';
    case 'list': return 'a, b,,c';
    case 'file': return fileFor(f);
    default: return `${f.key}-val`;
  }
}

// ── the mock host ────────────────────────────────────────────────────────────

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function rowFor(columns, n) {
  const row = {};
  columns.forEach((c, i) => { row[c] = n === 1 ? (i % 3 === 0 ? `${c}-${n}` : i % 3 === 1 ? 7 : { n }) : (i % 2 === 0 ? null : `${c}-${n}`); });
  return row;
}

/** Response for a request, by variant mode. The spec only shapes the canned data. */
function respond(spec, mode, req) {
  if (mode === 'null') return new Response(null, { status: 204 });
  if (mode === 'err404') return jsonRes({ error: 'not_found', message: 'No such thing.' }, 404);
  if (mode === 'err401') return jsonRes({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  if (mode === 'err403') return jsonRes({ error: 'forbidden', message: 'Nope.' }, 403);
  if (mode === 'err500') return jsonRes({ error: 'internal', message: 'Boom.' }, 500);
  if (mode === 'raw') return new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv' } });
  if (mode === 'listkey-miss') return jsonRes({ total: 2, other: [rowFor(spec.list?.columns ?? ['id'], 1)] });
  if (mode === 'array') return jsonRes([rowFor(spec.list?.columns ?? ['id'], 1)]);
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

function invocations(group, spec, fileFor) {
  const q = (spec.query ?? []).map(field);
  const b = (spec.body ?? []).map(field);
  const all = [...q, ...b];
  const allowBody = Boolean(spec.body || spec.rawBody);
  const pos = params(spec.route).map((p) => `${p}/1`);
  const org = hasOrg(spec.route) ? ['--org', 'o/1'] : [];
  const yes = spec.confirm ? ['--yes'] : [];
  const req = all.filter((f) => f.required).flatMap((f) => [f.flag, dummy(f, fileFor)]);
  const opt = (bool) => all.filter((f) => !f.required).flatMap((f) => [f.flag, dummy(f, fileFor, bool)]);
  const base = [group, ...spec.cmd, ...pos];
  const v = [];
  const add = (name, argv, mode = 'ok') => v.push({ name, argv, mode });

  add('min', [...base, ...org, ...req, ...yes]);
  add('min-json', ['--json', ...base, ...org, ...req, ...yes]);
  add('full', [...base, ...org, ...req, ...opt('true'), ...yes]);
  add('full-json', ['--json', ...base, ...org, ...req, ...opt('true'), ...yes]);
  if (all.some((f) => f.type === 'bool' && !f.required)) {
    add('full-false', [...base, ...org, ...req, ...opt('false'), ...yes]);
    add('bool-no', [...base, ...org, ...req, ...all.filter((f) => f.type === 'bool').flatMap((f) => [f.flag, 'no']), ...yes]);
  }
  if (allowBody) {
    add('body', [...base, ...org, ...req, '--body', '{"extra":1,"keep":"body"}', ...yes]);
    add('body-only', [...base, ...org, '--body', JSON.stringify(Object.fromEntries(b.map((f) => [f.key, 'from-body']))), ...yes]);
    add('body-file', [...base, ...org, ...req, '--body-file', fileFor({ key: '__body', json: '{"fromFile":true}' }), ...yes]);
    add('body-bad', [...base, ...org, ...req, '--body', '[1]', ...yes]);
  } else {
    add('body-rejected', [...base, ...org, ...req, '--body', '{}', ...yes]);
  }
  add('null', [...base, ...org, ...req, ...yes], 'null');
  add('null-json', ['--json', ...base, ...org, ...req, ...yes], 'null');
  add('err404', [...base, ...org, ...req, ...yes], 'err404');
  if (spec.list) {
    add('list-empty', [...base, ...org, ...req, ...yes], 'empty');
    add('list-key-miss', [...base, ...org, ...req, ...yes], 'listkey-miss');
    add('list-array', [...base, ...org, ...req, ...yes], 'array');
  }
  if (spec.text) {
    add('text', [...base, ...org, ...req, ...yes], 'raw');
    add('text-json', ['--json', ...base, ...org, ...req, ...yes], 'raw');
  }
  if (spec.confirm) add('no-yes', [...base, ...org, ...req]);
  if (org.length) add('no-org', [...base, ...req, ...yes]);
  if (pos.length) add('missing-positional', [...base.slice(0, -1), ...org, ...req, ...yes]);
  add('extra-positional', [...base, 'extra', ...org, ...req, ...yes]);
  for (const f of all.filter((x) => x.required)) {
    add(`missing ${f.flag}`, [...base, ...org, ...all.filter((x) => x.required && x !== f).flatMap((x) => [x.flag, dummy(x, fileFor)]), ...yes]);
  }
  const bad = { number: 'abc', bool: 'maybe', json: '{nope', file: '/nonexistent/openwop-snapshot' };
  for (const f of all) {
    if (bad[f.type] && !v.some((x) => x.name === `bad ${f.type}`)) {
      const rest = all.filter((x) => x.required && x !== f).flatMap((x) => [x.flag, dummy(x, fileFor)]);
      add(`bad ${f.type}`, [...base, ...org, ...rest, f.flag, bad[f.type], ...yes]);
    }
  }
  if (all.some((f) => f.type === 'number')) {
    const f = all.find((x) => x.type === 'number');
    const rest = all.filter((x) => x.required && x !== f).flatMap((x) => [x.flag, dummy(x, fileFor)]);
    add('blank number', [...base, ...org, ...rest, `${f.flag}=`, ...yes]);
  }
  add('sub-help', [...base, '--help']);
  return v;
}

// ── run ──────────────────────────────────────────────────────────────────────

export async function generateSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'openwop-snapshot-'));
  try {
    const groups = discoverGroups();
    const { runCli, specsOf } = await loadModules(groups, dir);
    let fileN = 0;
    const fileFor = (f) => {
      const path = join(dir, `f${fileN++}.txt`);
      writeFileSync(path, f.json ?? `${f.key}-secret\n`);
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
      const specs = specsOf(g);
      const entry = { specsId: g.specsId, help: await run([g.group, '--help']), commands: {} };
      result.helpCount++;
      for (const spec of specs) {
        const key = `${spec.method} ${spec.cmd.join(' ')} ${spec.route}`;
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
