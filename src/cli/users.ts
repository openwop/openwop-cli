import type { Ctx } from '../context.js';
/** `openwop users ...` — tenant identity directory + lifecycle (host users feature, ADR 0002). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const USERS_BASE = '/v1/host/sample/users';

// Mirror the host wire enum EXACTLY (usersService.ts USER_SOURCES).
const USER_SOURCES = ['oidc', 'password', 'saml', 'scim', 'manual'] as const;

export const USERS_HELP = `Usage:
  openwop users list [--json]
  openwop users get <userId> [--json]
  openwop users create --principal <id> [--email <e>] [--display-name <n>] [--group <g>]... [--source <s>] [--json]
  openwop users update <userId> [--email <e>] [--display-name <n>] [--group <g>]... [--json]
  openwop users disable <userId> [--json]
  openwop users enable <userId> [--json]
  openwop users delete <userId> [--yes]
  openwop users me [--display-name <n>] [--json]

Tenant identity DIRECTORY + account lifecycle (host users feature under ${USERS_BASE}).
This is the durable record of WHO exists in a tenant and whether their account is active —
NOT authorization. Role/permission membership lives in \`orgs\` (RBAC); editable persona /
self-profile lives in \`profiles\` and \`users me\`. The \`groups\` field here is the raw IdP
\`groups[]\` captured at sign-in for the RBAC handoff — it does not itself grant anything.

The host is the authority: every route resolves the caller's access server-side and the
surface 404s when the users feature isn't served for them — these commands fail closed
legibly (exit 2) rather than guessing. Lifecycle is fail-closed: a disabled account is
denied (403), surfaced legibly.

  --principal <id>    (create) The auth join key (e.g. oidc:<sub>) — required.
  --email <e>         Email address; on update, '' clears it.
  --display-name <n>  Display name; on update, '' clears it.
  --group <g>         An IdP group name (repeatable). On update, replaces the set.
  --source <s>        Identity source: ${USER_SOURCES.join(' | ')} (create; default manual).
  --yes               (delete) Confirm the destructive removal.

Exit codes: 0 ok · 1 host error · 2 usage error / surface not served / account disabled.

Examples:
  openwop users list
  openwop users me
  openwop users create --principal oidc:abc123 --email a@b.dev --group eng --source oidc
  openwop users update u_1 --display-name "Ada L." --group eng --group oncall
  openwop users disable u_1
  openwop users delete u_1 --yes
`;

// Probe + fail closed: a 404 means the host doesn't serve the users surface for this caller
// (backend authority / toggle off) — render that legibly instead of a bare HTTP 404.
async function usersRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2]) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404 && !/\/users\/users\//.test(path)) {
      // A 404 on the collection / me endpoints = surface not served (vs. a specific
      // unknown :id, which is a legitimate not-found we let pass through).
      throw new CliError(
        `Host does not serve the users surface at ${USERS_BASE} (backend authority — not enabled for this caller). Failing closed.`,
        2,
      );
    }
    throw err;
  }
}

export async function runUsers(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'create', 'update', 'disable', 'enable', 'delete', 'me'].includes(sub) ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, USERS_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return await runUsersList(ctx, args);
    case 'get':
      return await runUsersGet(ctx, args);
    case 'create':
      return await runUsersCreate(ctx, args);
    case 'update':
      return await runUsersUpdate(ctx, args);
    case 'disable':
    case 'enable':
      return await runUsersLifecycle(ctx, sub, args);
    case 'delete':
      return await runUsersDelete(ctx, args);
    case 'me':
      return await runUsersMe(ctx, args);
    default:
      throw new CliError(`Unknown users command: ${sub}\nRun \`openwop users --help\` for usage.`);
  }
}

function userRow(u: any) {
  return {
    userId: u.userId,
    principalId: u.principalId ?? '',
    displayName: u.displayName ?? '',
    source: u.source ?? '',
    status: u.status ?? '',
    groups: Array.isArray(u.groups) ? String(u.groups.length) : '0',
  };
}

const USER_COLS = ['userId', 'principalId', 'displayName', 'source', 'status', 'groups'];

function printUser(ctx: Ctx, u: any) {
  writeLine(ctx.io.stdout, `userId: ${u.userId ?? ''}`);
  writeLine(ctx.io.stdout, `principalId: ${u.principalId ?? ''}`);
  if (u.email) writeLine(ctx.io.stdout, `email: ${u.email}`);
  if (u.displayName) writeLine(ctx.io.stdout, `displayName: ${u.displayName}`);
  writeLine(ctx.io.stdout, `source: ${u.source ?? ''}`);
  writeLine(ctx.io.stdout, `status: ${u.status ?? ''}`);
  writeLine(ctx.io.stdout, `groups: ${Array.isArray(u.groups) && u.groups.length ? u.groups.join(', ') : '(none)'}`);
  if (u.createdAt) writeLine(ctx.io.stdout, `createdAt: ${u.createdAt}`);
}

async function runUsersList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, USERS_HELP);
    return 0;
  }
  const res = await usersRequest(ctx, `${USERS_BASE}/users`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const users = Array.isArray(res.body?.users) ? res.body.users : [];
  if (users.length === 0) {
    writeLine(ctx.io.stdout, 'No users in this tenant.');
    return 0;
  }
  writeLine(ctx.io.stdout, formatTable(users.map(userRow), USER_COLS));
  return 0;
}

async function runUsersGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop users get <userId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await usersRequest(ctx, `${USERS_BASE}/users/${encodeURIComponent(positionals[0])}`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  printUser(ctx, res.body ?? {});
  return 0;
}

async function runUsersCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--principal', '--email', '--display-name', '--source'],
    multi: ['--group'],
  });
  if (options.help || !options.principal) {
    write(ctx.io.stdout, 'Usage: openwop users create --principal <id> [--email <e>] [--display-name <n>] [--group <g>]... [--source <s>] [--json]\n');
    return options.help ? 0 : 2;
  }
  if (options.source !== undefined && !(USER_SOURCES as readonly string[]).includes(options.source)) {
    throw new CliError(`--source must be one of ${USER_SOURCES.join(', ')}`, 2);
  }
  const body: Record<string, any> = { principalId: options.principal };
  if (options.email !== undefined) body.email = options.email;
  if (options.displayName !== undefined) body.displayName = options.displayName;
  if (Array.isArray(options.group) && options.group.length) body.groups = options.group;
  if (options.source !== undefined) body.source = options.source;

  const res = await usersRequest(ctx, `${USERS_BASE}/users`, { method: 'POST', body });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `Created user ${res.body?.userId ?? ''} (${res.body?.principalId ?? options.principal}).`);
  return 0;
}

async function runUsersUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--email', '--display-name'],
    multi: ['--group'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop users update <userId> [--email <e>] [--display-name <n>] [--group <g>]... [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = {};
  // '' clears the field on the host (patchString → null); omit to leave unchanged.
  if (options.email !== undefined) body.email = options.email;
  if (options.displayName !== undefined) body.displayName = options.displayName;
  if (Array.isArray(options.group)) body.groups = options.group;
  if (Object.keys(body).length === 0) {
    throw new CliError('Nothing to update — pass --email, --display-name, and/or --group.', 2);
  }
  const res = await usersRequest(ctx, `${USERS_BASE}/users/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `Updated user ${positionals[0]}.`);
  return 0;
}

async function runUsersLifecycle(ctx: Ctx, verb: 'disable' | 'enable', argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop users ${verb} <userId> [--json]\n`);
    return options.help ? 0 : 2;
  }
  const res = await usersRequest(ctx, `${USERS_BASE}/users/${encodeURIComponent(positionals[0])}/${verb}`, { method: 'POST', body: {} });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `User ${positionals[0]} → ${res.body?.status ?? (verb === 'disable' ? 'disabled' : 'active')}.`);
  return 0;
}

async function runUsersDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop users delete <userId> [--yes]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) {
    writeLine(ctx.io.stderr, `Refusing to delete user ${positionals[0]} without --yes.`);
    return 2;
  }
  await usersRequest(ctx, `${USERS_BASE}/users/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted user ${positionals[0]}.`);
  return 0;
}

async function runUsersMe(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--display-name'] });
  if (options.help) {
    write(ctx.io.stdout, USERS_HELP);
    return 0;
  }
  const method = options.displayName !== undefined ? 'PATCH' : 'GET';
  const reqOptions = method === 'PATCH' ? { method: 'PATCH', body: { displayName: options.displayName } } : undefined;
  let res;
  try {
    res = await usersRequest(ctx, `${USERS_BASE}/me`, reqOptions);
  } catch (err) {
    // Fail-closed lifecycle: the host denies a disabled account with 403.
    if (err instanceof HttpError && err.status === 403) {
      throw new CliError('This account is disabled (host fail-closed, 403).', 2);
    }
    throw err;
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  printUser(ctx, res.body ?? {});
  return 0;
}
