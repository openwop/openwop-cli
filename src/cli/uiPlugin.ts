import type { Ctx } from '../context.js';
/**
 * `openwop ui-plugin ...` — UI plugin packs, their entry bundles, the demo
 * artifact, and the ui-plugin/1 host RPC (RFC 0117; ADR 0300 sandbox lane,
 * ADR 0367 trusted lane).
 *
 * Hits `/v1/host/openwop-app/ui-plugin/*`. `entry` / `trusted-entry` fetch the
 * served JavaScript bytes (print or save with --output). The trusted lane is
 * gated by the `trusted-plugins` toggle and re-verified per serve; every miss is
 * a uniform 404. `rpc` posts a ui-plugin/1 envelope to the product seam; the
 * `--conformance-alias` form targets `/v1/host/sample/ui-plugin/rpc`, which the
 * host mounts only under its test seam (404 in production).
 */
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, parseJsonResponse } from '../api.js';
import { resolveRequest } from '../protocol.js';
import { enc, parseJsonFlag, readBodyOption, renderDone, renderList } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/ui-plugin';
const RPC_PRODUCT = `${BASE}/rpc`;
const RPC_CONFORMANCE = '/v1/host/sample/ui-plugin/rpc';

export const UI_PLUGIN_HELP = `Usage:
  openwop ui-plugin packs [--json]
  openwop ui-plugin entry <packName> <pluginId> [--output <file>]
  openwop ui-plugin trusted-entry <packName> <pluginId> [--output <file>]
  openwop ui-plugin demo-artifact [--json]
  openwop ui-plugin rpc --method <m> [--params <json>] [--id <id>] [--conformance-alias] [--json]
  openwop ui-plugin rpc --body <json> | --body-file <path>

\`packs\` lists served plugins + the host's isolation mechanism + each plugin's tier
(GET ${BASE}/packs). \`entry\` fetches a plugin's sandboxed entry bundle
(GET ${BASE}/packs/<name>/plugins/<id>/entry); \`trusted-entry\` fetches a signed
pack's main-frame ES module (GET ${BASE}/trusted/<name>/plugins/<id>/entry.mjs —
404 unless the trusted-plugins toggle is on and the signature verifies).
\`demo-artifact\` ensures the idempotent demo artifact (POST ${BASE}/demo-artifact).
\`rpc\` sends one ui-plugin/1 request (POST ${RPC_PRODUCT}, body { message }); the
message is { openwop: "ui-plugin/1", type: "request", id (integer,
default 1), method, params } unless you pass a
whole body with --body/--body-file. --conformance-alias posts to the test-seam
alias ${RPC_CONFORMANCE} instead; that seam has no v2 equivalent (the v2
seams profile, api/seams-v2.yaml, defines no ui-plugin operation), so it is
always sent as the v1 path, on either protocol major.

Exit codes: 0 ok · 2 usage / not found / rejected request · 4 forbidden.

Examples:
  openwop ui-plugin packs
  openwop ui-plugin entry community.openwop.artifact-viewer viewer --output viewer.js
  openwop ui-plugin rpc --method artifact.read --params '{"artifactId":"ui-plugin-demo"}'
`;

/** A non-JSON GET against the host (plugin bundles). Same path rewrite + bearer as requestJson. */
export async function fetchRawText(ctx: Ctx, requestedPath: string, opts: { auth?: boolean; accept?: string } = {}): Promise<{ status: number; contentType: string; text: string }> {
  const { path, headers } = await resolveRequest(ctx, requestedPath, { accept: opts.accept ?? '*/*' });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (opts.auth !== false && ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const res = await ctx.fetchImpl(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, text ? parseJsonResponse(text) : null);
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text };
}

export async function runUiPlugin(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'packs';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, UI_PLUGIN_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--conformance-alias'],
    value: ['--output', '--method', '--params', '--id', '--body', '--body-file'],
  });
  if (options.help) { write(ctx.io.stdout, UI_PLUGIN_HELP); return 0; }
  switch (sub) {
    case 'packs': {
      const res = await requestJson(ctx, `${BASE}/packs`);
      const items = Array.isArray(res.body?.plugins) ? res.body.plugins : [];
      const code = renderList(ctx, res.body, items, ['packName', 'pluginId', 'tier'], 'No UI plugins served.');
      if (!ctx.json && res.body?.isolation !== undefined) writeLine(ctx.io.stdout, `isolation: ${typeof res.body.isolation === 'string' ? res.body.isolation : JSON.stringify(res.body.isolation)}`);
      return code;
    }
    case 'entry':
    case 'trusted-entry': {
      const [name, pluginId] = positionals;
      if (!name || !pluginId) { write(ctx.io.stderr, `Usage: openwop ui-plugin ${sub} <packName> <pluginId> [--output file]\n`); return 2; }
      const path = sub === 'entry'
        ? `${BASE}/packs/${enc(name)}/plugins/${enc(pluginId)}/entry`
        : `${BASE}/trusted/${enc(name)}/plugins/${enc(pluginId)}/entry.mjs`;
      const res = await fetchRawText(ctx, path);
      if (options.output) {
        writeFileSync(resolvePath(ctx.cwd, String(options.output)), res.text);
        writeLine(ctx.io.stdout, `Wrote ${res.text.length} bytes (${res.contentType || 'unknown type'}) to ${String(options.output)}`);
      } else {
        write(ctx.io.stdout, res.text.endsWith('\n') ? res.text : `${res.text}\n`);
      }
      return 0;
    }
    case 'demo-artifact': {
      const res = await requestJson(ctx, `${BASE}/demo-artifact`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Demo artifact ${res.body?.artifactId ?? ''} (version ${res.body?.version ?? ''}).`);
    }
    case 'rpc': {
      let body = readBodyOption(ctx, options);
      if (!body) {
        if (!options.method) { write(ctx.io.stderr, 'ui-plugin rpc needs --method (or --body/--body-file).\n'); return 2; }
        const id = options.id !== undefined ? Number(options.id) : 1;
        if (!Number.isInteger(id)) { write(ctx.io.stderr, 'ui-plugin rpc --id must be an integer.\n'); return 2; }
        const message: Record<string, unknown> = { openwop: 'ui-plugin/1', type: 'request', id, method: String(options.method) };
        if (options.params !== undefined) message.params = parseJsonFlag('--params', options.params);
        body = { message };
      }
      const res = await requestJson(ctx, options.conformanceAlias ? RPC_CONFORMANCE : RPC_PRODUCT, { method: 'POST', body });
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    default: throw new CliError(`Unknown ui-plugin command: ${sub}\nRun \`openwop ui-plugin --help\` for usage.`);
  }
}
