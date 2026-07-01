import type { Ctx } from '../context.js';
/** `openwop comments ...` — threaded collaboration comments (feature: comments, ADR 0021). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const base = (org: string) => `/v1/host/sample/comments/orgs/${encodeURIComponent(org)}/comments`;

export const COMMENTS_HELP = `Usage:
  openwop comments list --org <orgId> --resource-type <t> --resource-id <id> [--json]
  openwop comments create --org <orgId> --resource-type <t> --resource-id <id> --body <text> [--parent <commentId>] [--json]
  openwop comments update <commentId> --org <orgId> --body <text> [--json]
  openwop comments delete <commentId> --org <orgId> [--yes]

Threaded comments on a (resourceType, resourceId) target (host-extension, org-scoped,
ADR 0021). Every command needs --org. The host validates the resource in-org and emits
a notification on add/reply; the CLI mirrors + relays.
`;


export async function runComments(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, COMMENTS_HELP); return 0; }
  const args = argv.slice(['list', 'create', 'update', 'delete'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return commentsList(ctx, args);
    case 'create': return commentsCreate(ctx, args);
    case 'update': return commentsUpdate(ctx, args);
    case 'delete': return commentsDelete(ctx, args);
    default: throw new CliError(`Unknown comments command: ${sub}\nRun \`openwop comments --help\` for usage.`);
  }
}

async function commentsList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--org', '--resource-type', '--resource-id'] });
  if (options.help) { write(ctx.io.stdout, COMMENTS_HELP); return 0; }
  const org = requireOrg(options.org);
  if (!options.resourceType || !options.resourceId) { write(ctx.io.stderr, 'comments list needs --resource-type and --resource-id.\n'); return 2; }
  const q = `?resourceType=${encodeURIComponent(String(options.resourceType))}&resourceId=${encodeURIComponent(String(options.resourceId))}`;
  const res = await requestJson(ctx, `${base(org)}${q}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.comments) ? res.body.comments : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No comments.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((c: any) => ({ id: c.id ?? '', author: c.authorId ?? '', parent: c.parentId ?? '', body: (c.body ?? '').slice(0, 60) })),
    ['id', 'author', 'parent', 'body'],
  ));
  return 0;
}

async function commentsCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--org', '--resource-type', '--resource-id', '--body', '--parent'] });
  const org = requireOrg(options.org);
  if (!options.resourceType || !options.resourceId || !options.body) {
    write(ctx.io.stderr, 'comments create needs --resource-type, --resource-id, and --body.\n'); return 2;
  }
  const body: Record<string, unknown> = { resourceType: String(options.resourceType), resourceId: String(options.resourceId), body: String(options.body) };
  if (options.parent) body.parentId = String(options.parent);
  const res = await requestJson(ctx, base(org), { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Added comment ${res.body?.id ?? ''}.`);
  return 0;
}

async function commentsUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--org', '--body'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1 || !options.body) { write(ctx.io.stderr, 'Usage: openwop comments update <commentId> --org <orgId> --body <text> [--json]\n'); return 2; }
  const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body: { body: String(options.body) } });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Updated comment ${positionals[0]}.`);
  return 0;
}

async function commentsDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop comments delete <commentId> --org <orgId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to delete comment ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted comment ${positionals[0]}.`);
  return 0;
}
