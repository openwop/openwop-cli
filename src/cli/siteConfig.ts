import type { Ctx } from '../context.js';
/**
 * `openwop site-config ...` — the host's system marketing site switch (openwop-app
 * `routes/siteConfig.ts`, ADR 0487 public root split). `public` is the anonymous
 * read the frontend uses to decide whether `/` serves the system site; `get`/`set`
 * are the super-admin editor.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { gatedRequest, parseBool } from './adminShared.js';

const SURFACE = 'Site configuration';

export const SITE_CONFIG_HELP = `Usage:
  openwop site-config public [--json]
  openwop site-config get [--json]
  openwop site-config set --enabled true|false [--json]

The host's system site switch (host extension).
  public  GET /v1/host/openwop-app/public-site-config   anonymous: is the system site on (+ its org/slug)
  get     GET /v1/host/openwop-app/site-config          [super-admin] the stored config
  set     PUT /v1/host/openwop-app/site-config          [super-admin] turn the system site on/off

\`get\`/\`set\` are SUPER-ADMIN gated; without a super-admin principal they fail closed
with exit 4 and say how to get one. \`public\` sends no credentials.

Exit codes: 0 ok · 2 usage · 4 not a super-admin.

Examples:
  openwop site-config public
  openwop site-config set --enabled true
`;

export async function runSiteConfig(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'public';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, SITE_CONFIG_HELP); return 0; }
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--enabled'] });
  if (options.help) { write(ctx.io.stdout, SITE_CONFIG_HELP); return 0; }
  let res;
  switch (sub) {
    case 'public':
      res = await requestJson(ctx, '/v1/host/openwop-app/public-site-config', { auth: false });
      break;
    case 'get':
      res = await gatedRequest(ctx, '/v1/host/openwop-app/site-config', undefined, SURFACE, 'superadmin');
      break;
    case 'set':
      if (options.enabled === undefined) throw new CliError('Usage: openwop site-config set --enabled true|false', 2);
      res = await gatedRequest(ctx, '/v1/host/openwop-app/site-config', { method: 'PUT', body: { enabled: parseBool('--enabled', options.enabled) } }, SURFACE, 'superadmin');
      break;
    default:
      throw new CliError(`Unknown site-config command: ${sub}\nRun \`openwop site-config --help\` for usage.`);
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `system site: ${b.enabled ? 'enabled' : 'disabled'}${b.orgId ? ` (org ${b.orgId}, slug ${b.slug})` : ''}`);
  if (b.updatedAt) writeLine(ctx.io.stdout, `updated: ${b.updatedAt}${b.updatedBy ? ` by ${b.updatedBy}` : ''}`);
  return 0;
}
