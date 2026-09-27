import type { Ctx } from '../context.js';
/** `openwop sharing ...` — shareable resource links (feature: sharing, ADR 0013). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const links = (org: string) => `/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(org)}/links`;

export const SHARING_HELP = `Usage:
  openwop sharing list --org <orgId> [--json]
  openwop sharing create --org <orgId> --resource-type <t> --resource-id <id> [--json]
  openwop sharing revoke <token> --org <orgId> [--yes]
  openwop sharing resolve <token> [--json]
  openwop sharing card <token> [--json]
  openwop sharing frame-view <token> --frame <n>
  openwop sharing frame-views <token> --org <orgId> [--json]

Shareable links to a resource (host-extension, ADR 0013). \`list\`/\`create\`/\`revoke\`
are org-scoped (need --org, RBAC-gated). \`resolve\` reads a public /shared/<token>
link WITHOUT auth — the unguessable token IS the credential. \`card\` reads the
public link-preview card { title, description, imageUrl? }
(GET /v1/host/openwop-app/shared/<token>/card, no auth). \`frame-view\` records a
public viewer's frame view for per-frame analytics (POST …/shared/<token>/frame-view,
body { frame }, no auth; ADR 0328 P7). \`frame-views\` reads a link's per-frame
counts as its owner (GET …/sharing/orgs/<orgId>/links/<token>/frame-views).

Exit codes: 0 ok · 2 usage / not found / revoked · 4 forbidden.

Examples:
  openwop sharing resolve sh_tok
  openwop sharing card sh_tok --json
  openwop sharing frame-view sh_tok --frame 2
`;


export async function runSharing(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, SHARING_HELP); return 0; }
  const args = argv.slice(['list', 'create', 'revoke', 'resolve', 'card', 'frame-view', 'frame-views'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return sharingList(ctx, args);
    case 'create': return sharingCreate(ctx, args);
    case 'revoke': return sharingRevoke(ctx, args);
    case 'resolve': return sharingResolve(ctx, args);
    case 'card': return sharingCard(ctx, args);
    case 'frame-view': return sharingFrameView(ctx, args);
    case 'frame-views': return sharingFrameViews(ctx, args);
    default: throw new CliError(`Unknown sharing command: ${sub}\nRun \`openwop sharing --help\` for usage.`);
  }
}

async function sharingList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, SHARING_HELP); return 0; }
  const org = requireOrg(options.org);
  const res = await requestJson(ctx, links(org));
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.links) ? res.body.links : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No share links.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((l: any) => ({ token: l.token ?? '', resource: `${l.resourceType ?? ''}:${l.resourceId ?? ''}`, createdAt: l.createdAt ?? '' })),
    ['token', 'resource', 'createdAt'],
  ));
  return 0;
}

async function sharingCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--org', '--resource-type', '--resource-id'] });
  const org = requireOrg(options.org);
  if (!options.resourceType || !options.resourceId) { write(ctx.io.stderr, 'sharing create needs --resource-type and --resource-id.\n'); return 2; }
  const body = { resourceType: String(options.resourceType), resourceId: String(options.resourceId) };
  const res = await requestJson(ctx, links(org), { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Created share link ${res.body?.token ?? ''}${res.body?.url ? ` (${res.body.url})` : ''}.`);
  return 0;
}

async function sharingRevoke(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop sharing revoke <token> --org <orgId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to revoke share link ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, `${links(org)}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Revoked share link ${positionals[0]}.`);
  return 0;
}

async function sharingResolve(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop sharing resolve <token> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `/v1/host/openwop-app/shared/${encodeURIComponent(positionals[0])}`, { auth: false });
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

async function sharingCard(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop sharing card <token> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `/v1/host/openwop-app/shared/${encodeURIComponent(positionals[0])}/card`, { auth: false });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    [{ field: 'title', value: res.body?.title ?? '' }, { field: 'description', value: res.body?.description ?? '' }, { field: 'imageUrl', value: res.body?.imageUrl ?? '' }],
    ['field', 'value'],
  ));
  return 0;
}

async function sharingFrameView(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--frame'] });
  const frame = Number(options.frame);
  if (options.help || positionals.length !== 1 || options.frame === undefined || !Number.isInteger(frame) || frame < 0) {
    write(options.help ? ctx.io.stdout : ctx.io.stderr, 'Usage: openwop sharing frame-view <token> --frame <non-negative integer>\n');
    return options.help ? 0 : 2;
  }
  await requestJson(ctx, `/v1/host/openwop-app/shared/${encodeURIComponent(positionals[0])}/frame-view`, { method: 'POST', body: { frame }, auth: false });
  if (ctx.json) writeJson(ctx.io.stdout, { ok: true, frame }); else writeLine(ctx.io.stdout, `Recorded a view of frame ${frame}.`);
  return 0;
}

async function sharingFrameViews(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop sharing frame-views <token> --org <orgId> [--json]\n'); return options.help ? 0 : 2; }
  const org = requireOrg(options.org);
  const res = await requestJson(ctx, `${links(org)}/${encodeURIComponent(positionals[0])}/frame-views`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.frames) ? res.body.frames : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No frame views recorded.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(items.map((f: any) => ({ frame: f.frame ?? '', views: f.count ?? f.views ?? '' })), ['frame', 'views']));
  return 0;
}
