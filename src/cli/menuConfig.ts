import type { Ctx } from '../context.js';
/**
 * `openwop menu-config ...` — navigation menu layout (openwop-app
 * `features/navigation-settings/routes.ts`). Two layers: the workspace default
 * (super-admin) and the caller's personal override. Writes REPLACE the layer, so
 * `set` sends the whole config you supply; the tenant write is guarded by the
 * host's ETag (If-Match), read just before the write, so a concurrent edit is
 * refused (409) instead of silently clobbered.
 */
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { gatedRequest, readBodyOption } from './adminShared.js';

const BASE = '/v1/host/openwop-app/menu-config';

export const MENU_CONFIG_HELP = `Usage:
  openwop menu-config [get] [--json]
  openwop menu-config set me     (--body <json> | --body-file <path>) [--json]
  openwop menu-config set tenant (--body <json> | --body-file <path>) [--json]

Navigation menu layout (host extension).
  get         GET ${BASE}          {tenant, user} layers for the caller
  set me      PUT ${BASE}/me       replace YOUR personal layer (signed-in user)
  set tenant  PUT ${BASE}/tenant   [super-admin] replace the workspace default layer

The body is the menu config object ({"items": {...}, "headers": [...]}) or the full
request ({"config": {...}}). A write REPLACES that layer. \`set tenant\` reads the current
version first and sends it as If-Match, so a concurrent edit fails with 409 rather than
being overwritten. Without a super-admin principal \`set tenant\` fails closed with exit 4.

Exit codes: 0 ok · 2 usage / validation / conflict · 4 not signed in / not a super-admin.

Examples:
  openwop menu-config --json > menu.json
  openwop menu-config set me --body '{"items":{"/crm":{"hidden":true}},"headers":[]}'
  openwop menu-config set tenant --body-file ./tenant-menu.json
`;

export async function runMenuConfig(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'get';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, MENU_CONFIG_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--body', '--body-file'] });
  if (options.help) { write(ctx.io.stdout, MENU_CONFIG_HELP); return 0; }
  if (sub === 'get') {
    const res = await requestJson(ctx, BASE);
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  if (sub !== 'set') throw new CliError(`Unknown menu-config command: ${sub}\nRun \`openwop menu-config --help\` for usage.`);
  const layer = positionals[0];
  const raw = readBodyOption(ctx, options);
  if ((layer !== 'me' && layer !== 'tenant') || !raw) {
    throw new CliError('Usage: openwop menu-config set me|tenant (--body <json> | --body-file <path>)', 2);
  }
  const body = 'config' in raw ? raw : { config: raw };
  let res;
  if (layer === 'me') {
    res = await gatedRequest(ctx, `${BASE}/me`, { method: 'PUT', body }, 'Editing your menu layout', 'signed-in');
  } else {
    const current = await requestJson(ctx, BASE);
    const etag = current.headers.get('etag');
    res = await gatedRequest(ctx, `${BASE}/tenant`, { method: 'PUT', body, ...(etag ? { headers: { 'if-match': etag } } : {}) },
      'Editing the workspace default menu layout', 'superadmin');
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  write(ctx.io.stdout, `Saved the ${layer === 'me' ? 'personal' : 'workspace default'} menu layout.\n`);
  return 0;
}
