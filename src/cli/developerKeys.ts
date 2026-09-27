import type { Ctx } from '../context.js';
/**
 * `openwop developer-keys ...` — self-service developer API keys (openwop-app
 * ADR 0270 / CDP-H, `features/developer-keys/routes.ts`). A self-service caller
 * manages only the keys they created; an admin|owner sees every key in the
 * workspace. The host returns the plaintext token ONCE on issue — this command
 * prints it once with a warning and never stores or logs it.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { gatedRequest, arrayOf } from './adminShared.js';

const BASE = '/v1/host/openwop-app/developer-keys';
const SURFACE = 'Managing developer API keys';

export const DEVELOPER_KEYS_HELP = `Usage:
  openwop developer-keys list [--json]
  openwop developer-keys create --name <n> [--scope <s>]... [--expires-at <iso>] [--json]
  openwop developer-keys revoke <keyId> --yes [--json]

Developer API keys for this workspace (host extension under ${BASE}). Requires an
authenticated principal (not an anonymous session); an admin or owner sees and can
revoke every key in the workspace, anyone else only their own.

  list     GET    ${BASE}          keys (public fields only — never the token or its hash)
  create   POST   ${BASE}          issue a key; the token is shown ONCE
  revoke   DELETE ${BASE}/:keyId   revoke (404 when the key is not yours / not in this workspace)

ONE-TIME SECRET: \`create\` prints the new token exactly once, on stdout, with a warning.
Store it immediately — the host keeps only a hash and cannot show it again. The CLI does
not save it anywhere.

  --name <n>          (create) Display name. Required.
  --scope <s>         (create) Scope granted to the key (repeatable).
  --expires-at <iso>  (create) Expiry timestamp.
  --yes               (revoke) Required confirmation.

Exit codes: 0 ok · 2 usage / not found · 4 not signed in.

Examples:
  openwop developer-keys list
  openwop developer-keys create --name "CI deploy" --scope runs:write
  openwop developer-keys revoke dk:0123abcd --yes
`;

export async function runDeveloperKeys(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, DEVELOPER_KEYS_HELP); return 0; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': return await keysList(ctx, rest);
    case 'create': return await keysCreate(ctx, rest);
    case 'revoke':
    case 'delete': return await keysRevoke(ctx, rest);
    default:
      throw new CliError(`Unknown developer-keys command: ${sub}\nRun \`openwop developer-keys --help\` for usage.`);
  }
}

async function keysList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, DEVELOPER_KEYS_HELP); return 0; }
  const res = await gatedRequest(ctx, BASE, undefined, SURFACE, 'signed-in');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const keys = arrayOf(res.body, 'keys');
  if (keys.length === 0) { writeLine(ctx.io.stdout, 'No developer keys. Create one with `openwop developer-keys create --name <n>`.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(keys.map((k: any) => ({
    keyId: k.keyId ?? '',
    name: k.name ?? '',
    scopes: Array.isArray(k.scopes) ? k.scopes.join(',') : '',
    status: k.revokedAt ? 'revoked' : 'active',
    createdAt: k.createdAt ?? '',
    lastUsedAt: k.lastUsedAt ?? '',
  })), ['keyId', 'name', 'scopes', 'status', 'createdAt', 'lastUsedAt']));
  return 0;
}

async function keysCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--name', '--expires-at'], multi: ['--scope'] });
  if (options.help || !options.name) {
    write(ctx.io.stdout, 'Usage: openwop developer-keys create --name <n> [--scope <s>]... [--expires-at <iso>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { name: options.name };
  if (Array.isArray(options.scope) && options.scope.length) body.scopes = options.scope;
  if (options.expiresAt) body.expiresAt = options.expiresAt;
  const res = await gatedRequest(ctx, BASE, { method: 'POST', body }, SURFACE, 'signed-in');
  // One-time reveal: the host returns the token ONCE. Print it once (stdout), warn on stderr.
  writeLine(ctx.io.stderr, 'WARNING: this token is shown ONCE. Store it now — it cannot be retrieved again.');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const key = res.body?.key ?? {};
  writeLine(ctx.io.stdout, `Created key ${key.keyId ?? ''} (${key.name ?? options.name}).`);
  writeLine(ctx.io.stdout, `token: ${res.body?.token ?? '(not returned)'}`);
  return 0;
}

async function keysRevoke(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop developer-keys revoke <keyId> --yes [--json]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to revoke ${positionals[0]} without --yes.`); return 2; }
  await gatedRequest(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' }, SURFACE, 'signed-in');
  if (ctx.json) { writeJson(ctx.io.stdout, { keyId: positionals[0], revoked: true }); return 0; }
  writeLine(ctx.io.stdout, `Revoked ${positionals[0]}.`);
  return 0;
}
