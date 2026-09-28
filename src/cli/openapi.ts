import type { Ctx } from '../context.js';
/**
 * `openwop openapi` — fetch the host's served OpenAPI document. Under major 2
 * the request is `GET /openapi.json` + `OpenWOP-Version: 2.0` (spec/v2
 * path-manifest getOpenApiSpec — the `/v1/openapi.json` key is a v1 operation);
 * under major 1 it is `GET /v1/openapi.json` (src/protocol.ts `V2_RENAMED`).
 *
 * Golden rule 1 says commands are driven off `/.well-known/openwop` + the
 * OpenAPI document; this exposes the latter so an operator can see exactly
 * which operations the host serves.
 */
import { writeFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const OPENAPI_HELP = `Usage:
  openwop openapi [--out <file>] [--json]
  openwop openapi paths [--filter <text>] [--json]

Fetch the host's OpenAPI document — the document the host serves, which lists
the operations it implements. A host that speaks protocol major 2 is asked for
GET /openapi.json with OpenWOP-Version: 2.0 (its v2 document); a v1-only host
for GET /v1/openapi.json.

  (default)  Prints the document's title, version and operation count; --json
             prints the whole document; --out <file> saves it.
  paths      Lists every served path + method (--filter narrows by substring).

Examples:
  openwop openapi --out host-openapi.json
  openwop openapi paths --filter runs
`;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export async function runOpenapi(ctx: Ctx, argv: string[]): Promise<number> {
  const listPaths = argv[0] === 'paths';
  const { options } = parseOptions(listPaths ? argv.slice(1) : argv, { bool: ['--help'], value: ['--out', '--filter'] });
  if (options.help || argv[0] === '--help' || argv[0] === '-h') { write(ctx.io.stdout, OPENAPI_HELP); return 0; }
  if (!listPaths && argv.length && !argv[0].startsWith('-')) throw new CliError(`Unknown openapi command: ${argv[0]}\nRun \`openwop openapi --help\` for usage.`);
  const res = await requestJson(ctx, '/v1/openapi.json', { auth: false });
  const doc = res.body ?? {};
  const paths: Record<string, any> = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  const ops = Object.entries(paths).flatMap(([p, item]) =>
    METHODS.filter((m) => item && typeof item === 'object' && m in item).map((m) => ({ method: m.toUpperCase(), path: p, operationId: item[m]?.operationId ?? '' })));
  if (listPaths) {
    const f = options.filter ? String(options.filter) : '';
    const rows = f ? ops.filter((o) => o.path.includes(f) || o.operationId.includes(f)) : ops;
    if (ctx.json) { writeJson(ctx.io.stdout, rows); return 0; }
    writeLine(ctx.io.stdout, rows.length ? formatTable(rows, ['method', 'path', 'operationId']) : 'No matching operations.');
    return 0;
  }
  if (options.out) {
    writeFileSync(String(options.out), `${JSON.stringify(doc, null, 2)}\n`);
    writeLine(ctx.io.stdout, `Wrote the host's OpenAPI document (${ops.length} operations) to ${options.out}.`);
    return 0;
  }
  if (ctx.json) { writeJson(ctx.io.stdout, doc); return 0; }
  writeLine(ctx.io.stdout, `openapi: ${doc.openapi ?? ''}`);
  writeLine(ctx.io.stdout, `title: ${doc.info?.title ?? ''}`);
  writeLine(ctx.io.stdout, `version: ${doc.info?.version ?? ''}`);
  writeLine(ctx.io.stdout, `operations: ${ops.length} across ${Object.keys(paths).length} paths (list them with \`openwop openapi paths\`)`);
  return 0;
}
