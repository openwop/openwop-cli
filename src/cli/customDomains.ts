import type { Ctx } from '../context.js';
/**
 * `openwop custom-domains ...` — bind a customer hostname to an org's published
 * pages (openwop-app ADR 0295 / Funnel B, `features/custom-domains/routes.ts`).
 * Ownership is proven by a DNS TXT record at `_openwop-verify.<hostname>`; the
 * host checks it (on `verify` and on its own sweep). The host is the authority
 * on status — this command only renders it.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { arrayOf } from './adminShared.js';

const base = (orgId: string) => `/v1/host/openwop-app/custom-domains/orgs/${encodeURIComponent(orgId)}/domains`;

export const CUSTOM_DOMAINS_HELP = `Usage:
  openwop custom-domains list --org <orgId> [--json]
  openwop custom-domains add <hostname> --org <orgId> [--json]
  openwop custom-domains verify <hostname> --org <orgId> [--json]
  openwop custom-domains remove <hostname> --org <orgId> --yes [--json]

Custom domains for an org's published pages (host extension; toggle 'custom-domains').
  list    GET    /v1/host/openwop-app/custom-domains/orgs/:orgId/domains                    [workspace:read]
  add     POST   /v1/host/openwop-app/custom-domains/orgs/:orgId/domains                    [workspace:write]
  verify  POST   /v1/host/openwop-app/custom-domains/orgs/:orgId/domains/:hostname/verify   [workspace:write]
  remove  DELETE /v1/host/openwop-app/custom-domains/orgs/:orgId/domains/:hostname          [workspace:write]

After \`add\`, publish the returned verification token as a DNS TXT record at
_openwop-verify.<hostname>, then run \`verify\`. Status: pending | live | failed (the
host's lastError says why a check failed).

Exit codes: 0 ok (verify: live) · 3 verify ran but the domain is not live yet · 2 usage / not found / feature off · 4 permission denied.

Examples:
  openwop custom-domains add pages.example.com --org o_1
  openwop custom-domains verify pages.example.com --org o_1
  openwop custom-domains list --org o_1 --json
`;

export async function runCustomDomains(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CUSTOM_DOMAINS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help', '--yes'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, CUSTOM_DOMAINS_HELP); return 0; }
  if (!['list', 'add', 'verify', 'remove', 'delete'].includes(sub)) {
    throw new CliError(`Unknown custom-domains command: ${sub}\nRun \`openwop custom-domains --help\` for usage.`);
  }
  const orgId = requireOrg(options.org);
  if (sub === 'list') {
    const res = await requestJson(ctx, base(orgId));
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const domains = arrayOf(res.body, 'domains');
    if (domains.length === 0) { writeLine(ctx.io.stdout, `No custom domains for org ${orgId}.`); return 0; }
    writeLine(ctx.io.stdout, formatTable(domains.map((d: any) => ({
      hostname: d.hostname, status: d.status ?? '', verifiedAt: d.verifiedAt ?? '', lastError: d.lastError ?? '',
    })), ['hostname', 'status', 'verifiedAt', 'lastError']));
    return 0;
  }
  const hostname = positionals[0];
  if (!hostname) throw new CliError(`Usage: openwop custom-domains ${sub} <hostname> --org <orgId>`, 2);
  if (sub === 'add') {
    const res = await requestJson(ctx, base(orgId), { method: 'POST', body: { hostname } });
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const d = res.body?.domain ?? {};
    writeLine(ctx.io.stdout, `Added ${d.hostname ?? hostname} (status ${d.status ?? 'pending'}).`);
    writeLine(ctx.io.stdout, `Publish TXT _openwop-verify.${d.hostname ?? hostname} = ${d.verificationToken ?? '(see --json)'} then run \`openwop custom-domains verify ${d.hostname ?? hostname} --org ${orgId}\`.`);
    return 0;
  }
  if (sub === 'verify') {
    const res = await requestJson(ctx, `${base(orgId)}/${encodeURIComponent(hostname)}/verify`, { method: 'POST', body: {} });
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const d = res.body?.domain ?? {};
    writeLine(ctx.io.stdout, `${d.hostname ?? hostname}: ${d.status ?? '?'}${d.lastError ? ` — ${d.lastError}` : ''}`);
    return d.status === 'live' ? 0 : 3;
  }
  if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to remove ${hostname} without --yes.`); return 2; }
  const res = await requestJson(ctx, `${base(orgId)}/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Removed ${hostname}.`);
  return 0;
}
