import type { Ctx } from '../context.js';
/** `openwop orgs ...` — orgs/teams/groups/roles/members RBAC (RFC 0049 authorization). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { readSecret } from '../prompt.js';

export const ORGS_HELP = `Usage:
  openwop orgs list [--json]
  openwop orgs get <orgId> [--json]
  openwop orgs create --name <name> [--description <text>] [--json]
  openwop orgs update <orgId> [--name <name>] [--description <text>] [--json]
  openwop orgs delete <orgId> [--yes]

  openwop orgs teams   <orgId> list|create|update|delete [...]
  openwop orgs groups  <orgId> list|create|update|delete [...]
  openwop orgs roles   <orgId> list|create|update|delete [...]
  openwop orgs members <orgId> list|create|update|delete [...]

  openwop orgs members <orgId> transfer-ownership <memberId> [--step-down] [--json]
  openwop orgs members <orgId> candidates [--for-link] [--json]
  openwop orgs members <orgId> add-existing (--candidate <id> | --email <e>) [--role <id>]... [--json]
  openwop orgs members <orgId> link <memberId> (--candidate <id> | --email <e>) [--json]
  openwop orgs invites <orgId> list|create|revoke [...]
  openwop orgs invitations preview|accept|decline [--token <t>] [--json]

  openwop orgs role-catalog [--json]          # the host's global role catalog (GET /roles)
  openwop orgs effective [--subject <id> | --member <memberId>] [--org <orgId>] [--json]
  openwop orgs decide --principal <id> --action <scope> [--resource <r>] [--json]

Organizations + RBAC (RFC 0049, authorization fail-closed). Orgs own teams,
groups, roles, and members; an effective-access query resolves a subject's
granted scopes. Drives the host-extension surface under /host/openwop-app/orgs,
/host/openwop-app/roles, /host/openwop-app/access/effective, and
/host/openwop-app/authorization/decide.

  effective           GET  /access/effective — the caller's own resolution by default
                      (includes the host's superadmin flag); --member / --subject preview
                      someone else; --org scopes it to one org.
  decide              POST /authorization/decide — the RFC 0049 fail-closed decision seam;
                      prints ONLY the host's {allowed}. 404s when the host does not enforce
                      authorization. Exit 0 = allowed, 1 = denied.
  transfer-ownership  POST /orgs/:orgId/members/:memberId/transfer-ownership — grant owner
                      to a member; --step-down also drops YOUR owner role (last-owner escape).
  candidates          GET /host/openwop-app/orgs/:orgId/member-candidates — the people who
                      already have an account and that you may add here (people in the orgs
                      you can act in). --for-link keeps this org's own members, for \`link\`.
  add-existing        POST /host/openwop-app/orgs/:orgId/members/add-existing — add someone who
                      already has an account, bound to their sign-in at once, no email.
                      --candidate takes an id from \`candidates\`. --email (host superadmins
                      only) looks one exact address up first; a miss exits 1 and means
                      "send an invitation instead". Needs host:members:manage. (ADR 1123)
  link                POST /host/openwop-app/orgs/:orgId/members/:memberId/link — tie a member
                      row that has no account to one. If the person is already a member
                      here, the row is removed and their membership kept.
  invites             GET/POST/DELETE /orgs/:orgId/invites[/:inviteId] (needs host:members:manage)
                      create: --email <e> [--role <roleId>] (host default role: viewer)
  invitations         GET /orgs/invitations/preview?token=, POST /orgs/invitations/accept|decline
                      — the invitee's side. Pass --token, or omit it to be prompted (no echo).

Nested-entity flags:
  teams   create/update  --name <n> [--description <t>] [--color <c>]
  groups  create/update  --name <n> [--description <t>] [--role <id>]... [--member <id>]...
  roles   create/update  --name <n> [--description <t>] [--scope <s>]...
  members create         --display-name <n> [--subject <id>] [--email <e>] [--role <id>]... [--team <id>]...
                         --subject user:… is DEPRECATED for people: use add-existing (the host
                         will refuse it later, openwop-app#5945). Service and IdP subjects stay.
  members update         [--display-name <n>] [--email <e>] [--role <id>]... [--team <id>]...

Examples:
  openwop orgs create --name "Acme"
  openwop orgs teams o_1 create --name "Support" --color blue
  openwop orgs roles o_1 create --name "Reviewer" --scope runs:read --scope runs:annotate
  openwop orgs members o_1 candidates
  openwop orgs members o_1 add-existing --candidate m:3f2a --role role_reviewer
  openwop orgs members o_1 link m_9 --candidate m:3f2a
  openwop orgs members o_1 create --subject oidc:ci-bot --display-name "CI bot" --role viewer
  openwop orgs effective --subject user:jo
  openwop orgs decide --principal user:jo --action runs:read
  openwop orgs invites o_1 create --email jo@acme.com --role editor
  openwop orgs invitations accept --token <token-from-invite-link>
  openwop orgs members o_1 transfer-ownership m_2 --step-down
`;

const ENTITIES = ['teams', 'groups', 'roles', 'members'] as const;
type Entity = (typeof ENTITIES)[number];

export async function runOrgs(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, ORGS_HELP); return 0; }
  if (sub === 'members' && argv[2] === 'transfer-ownership') {
    return await transferOwnership(ctx, argv[1], argv.slice(3));
  }
  if (sub === 'members' && ['candidates', 'add-existing', 'link'].includes(argv[2] ?? '')) {
    return await memberAddExisting(ctx, argv[1], argv[2]!, argv.slice(3));
  }
  if ((ENTITIES as readonly string[]).includes(sub)) {
    return await runEntity(ctx, sub as Entity, argv.slice(1));
  }
  if (sub === 'invites') return await runInvites(ctx, argv.slice(1));
  if (sub === 'invitations') return await runInvitations(ctx, argv.slice(1));
  const args = ['list', 'get', 'create', 'update', 'delete', 'role-catalog', 'effective', 'decide'].includes(sub) ? argv.slice(1) : argv;
  switch (sub) {
    case 'list': return await orgsList(ctx, args);
    case 'get': return await orgsGet(ctx, args);
    case 'create': return await orgsCreate(ctx, args);
    case 'update': return await orgsUpdate(ctx, args);
    case 'delete': return await orgsDelete(ctx, args);
    case 'role-catalog': return await roleCatalog(ctx, args);
    case 'effective': return await effectiveAccess(ctx, args);
    case 'decide': return await decide(ctx, args);
    default:
      throw new CliError(`Unknown orgs command: ${sub}\nRun \`openwop orgs --help\` for usage.`);
  }
}

// ── org level ────────────────────────────────────────────────────────────
async function orgsList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, ORGS_HELP); return 0; }
  const res = await requestJson(ctx, '/host/openwop-app/orgs');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const orgs = arrayOf(res.body, 'orgs');
  if (orgs.length === 0) { writeLine(ctx.io.stdout, 'No organizations. Create one with `openwop orgs create --name <name>`.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(orgs.map((o: any) => ({
    orgId: o.orgId ?? o.id, name: o.name ?? '', description: o.description ?? '',
  })), ['orgId', 'name', 'description']));
  return 0;
}

async function orgsGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop orgs get <orgId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `/host/openwop-app/orgs/${encodeURIComponent(positionals[0])}`);
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

async function orgsCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--name', '--description'] });
  if (options.help || !options.name) { write(ctx.io.stdout, 'Usage: openwop orgs create --name <name> [--description <text>] [--json]\n'); return options.help ? 0 : 2; }
  const body: Record<string, any> = { name: options.name };
  if (options.description) body.description = options.description;
  const res = await requestJson(ctx, '/host/openwop-app/orgs', { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Created org ${res.body?.orgId ?? res.body?.id} (${res.body?.name}).`);
  return 0;
}

async function orgsUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--name', '--description'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop orgs update <orgId> [--name <name>] [--description <text>] [--json]\n'); return options.help ? 0 : 2; }
  const body: Record<string, any> = {};
  if (options.name) body.name = options.name;
  if (options.description) body.description = options.description;
  if (Object.keys(body).length === 0) throw new CliError('Nothing to update — pass --name and/or --description.', 2);
  const res = await requestJson(ctx, `/host/openwop-app/orgs/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Updated org ${positionals[0]}.`);
  return 0;
}

async function orgsDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop orgs delete <orgId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete org ${positionals[0]} without --yes (removes its teams, roles, and memberships).`); return 2; }
  await requestJson(ctx, `/host/openwop-app/orgs/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted org ${positionals[0]}.`);
  return 0;
}

// ── global role catalog + effective access ────────────────────────────────
async function roleCatalog(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop orgs role-catalog [--json]\n'); return 0; }
  const res = await requestJson(ctx, '/host/openwop-app/roles');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const roles = arrayOf(res.body, 'roles');
  writeLine(ctx.io.stdout, formatTable(roles.map((r: any) => ({
    roleId: r.roleId ?? r.id, name: r.name ?? '', scopes: Array.isArray(r.scopes) ? r.scopes.join(',') : '',
  })), ['roleId', 'name', 'scopes']));
  return 0;
}

async function effectiveAccess(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--subject', '--member', '--org'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop orgs effective [--subject <id> | --member <memberId>] [--org <orgId>] [--json]\n'); return 0; }
  const qs = new URLSearchParams();
  if (options.member) qs.set('memberId', String(options.member));
  if (options.subject) qs.set('subject', String(options.subject));
  if (options.org) qs.set('orgId', String(options.org));
  const q = qs.toString() ? `?${qs}` : '';
  const res = await requestJson(ctx, `/host/openwop-app/access/effective${q}`);
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

/** POST /authorization/decide — render ONLY the host's {allowed}; exit 0 allowed / 1 denied. */
async function decide(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--principal', '--action', '--resource'] });
  if (options.help || !options.action) {
    write(ctx.io.stdout, 'Usage: openwop orgs decide --principal <id> --action <scope> [--resource <r>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { action: options.action };
  if (options.principal) body.principal = options.principal;
  if (options.resource) body.resource = options.resource;
  let res;
  try {
    res = await requestJson(ctx, '/host/openwop-app/authorization/decide', { method: 'POST', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError('This host does not enforce authorization (capabilities.authorization.supported is false) — the decision seam is not served. Failing closed.', 2);
    }
    throw err;
  }
  const allowed = res.body?.allowed === true;
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `${allowed ? 'ALLOWED' : 'DENIED'}: ${options.principal ?? '(caller)'} → ${options.action}`);
  return allowed ? 0 : 1;
}

async function transferOwnership(ctx: Ctx, orgId: string | undefined, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--step-down'] });
  if (options.help || !orgId || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop orgs members <orgId> transfer-ownership <memberId> [--step-down] [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(positionals[0])}/transfer-ownership`, {
    method: 'POST', body: options.stepDown ? { stepDown: true } : {},
  });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Ownership granted to ${res.body?.transferredTo ?? positionals[0]}${res.body?.steppedDown ? `; you stepped down (member ${res.body.steppedDown})` : ''}.`);
  return 0;
}

// ── add an existing person / link a row (ADR 1123, routes/orgAddExisting.ts) ──
async function memberAddExisting(ctx: Ctx, orgId: string | undefined, verb: string, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--for-link'], value: ['--candidate', '--email'], multi: ['--role'] });
  const usage = verb === 'candidates'
    ? 'Usage: openwop orgs members <orgId> candidates [--for-link] [--json]\n'
    : verb === 'link'
      ? 'Usage: openwop orgs members <orgId> link <memberId> (--candidate <id> | --email <e>) [--json]\n'
      : 'Usage: openwop orgs members <orgId> add-existing (--candidate <id> | --email <e>) [--role <id>]... [--json]\n';
  if (options.help) { write(ctx.io.stdout, usage); return 0; }
  if (!orgId) { write(ctx.io.stderr, usage); return 2; }
  const base = `/host/openwop-app/orgs/${encodeURIComponent(orgId)}`;

  if (verb === 'candidates') {
    const res = await requestJson(ctx, `${base}/member-candidates${options.forLink ? '?for=link' : ''}`);
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const rows = arrayOf(res.body, 'candidates');
    if (rows.length === 0) { writeLine(ctx.io.stdout, `Nobody else can be added to org ${orgId}. Invite them: \`openwop orgs invites ${orgId} create --email <e>\`.`); return 0; }
    writeLine(ctx.io.stdout, formatTable(rows.map((c: any) => ({ candidateId: c.candidateId, name: c.displayName ?? '', email: c.email ?? '' })), ['candidateId', 'name', 'email']));
    return 0;
  }

  if (verb === 'link' && positionals.length !== 1) { write(ctx.io.stderr, usage); return 2; }
  if ((options.candidate === undefined) === (options.email === undefined)) {
    writeLine(ctx.io.stderr, 'Pass exactly one of --candidate <id> (from `candidates`) or --email <e> (host superadmins only).');
    return 2;
  }
  let who: Record<string, string>;
  if (options.email !== undefined) {
    // The host answers a miss, a hidden account and an ambiguous address alike.
    const found = await requestJson(ctx, `${base}/member-lookup`, { method: 'POST', body: { email: options.email } });
    const token = found.body?.candidate?.lookupToken;
    if (typeof token !== 'string') {
      writeLine(ctx.io.stderr, `No account to add with that email. Send an invitation instead: \`openwop orgs invites ${orgId} create --email <e>\`.`);
      return 1;
    }
    who = { lookupToken: token };
  } else {
    who = { candidateId: String(options.candidate) };
  }

  if (verb === 'link') {
    const res = await requestJson(ctx, `${base}/members/${encodeURIComponent(positionals[0]!)}/link`, { method: 'POST', body: who });
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    writeLine(ctx.io.stdout, `Linked: member ${res.body?.memberId ?? positionals[0]} in org ${orgId} is tied to that account.`);
    return 0;
  }
  const roles = Array.isArray(options.role) && options.role.length ? options.role : undefined;
  const res = await requestJson(ctx, `${base}/members/add-existing`, { method: 'POST', body: { ...who, ...(roles ? { roles } : {}) } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Added ${res.body?.displayName ?? 'them'} to org ${orgId} as member ${res.body?.memberId ?? '?'} (${(res.body?.roles ?? []).join(', ') || 'default role'}). They have access now and were notified.`);
  return 0;
}

// ── invites (admin side) + invitations (invitee side) — features/orgs/routes.ts ──
async function runInvites(ctx: Ctx, argv: string[]) {
  const orgId = argv[0];
  const verb = argv[1] ?? 'list';
  if (!orgId || orgId === '--help' || orgId === '-h') {
    write(ctx.io.stdout, 'Usage: openwop orgs invites <orgId> list | create --email <e> [--role <roleId>] | revoke <inviteId> --yes\n');
    return orgId ? 0 : 2;
  }
  const base = `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/invites`;
  const { options, positionals } = parseOptions(argv.slice(2), { bool: ['--help', '--yes'], value: ['--email', '--role'] });
  switch (verb) {
    case 'list': {
      const res = await requestJson(ctx, base);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const invites = arrayOf(res.body, 'invites');
      if (invites.length === 0) { writeLine(ctx.io.stdout, `No pending invites in org ${orgId}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(invites.map((i: any) => ({
        inviteId: i.inviteId, email: i.email ?? '', role: i.role ?? '', status: i.expired ? 'expired' : (i.status ?? 'pending'), expiresAt: i.expiresAt ?? '',
      })), ['inviteId', 'email', 'role', 'status', 'expiresAt']));
      return 0;
    }
    case 'create': {
      if (!options.email) { writeLine(ctx.io.stderr, 'invites create requires --email.'); return 2; }
      const body: Record<string, any> = { email: options.email };
      if (options.role) body.role = options.role;
      const res = await requestJson(ctx, base, { method: 'POST', body });
      if (res.body?.token) writeLine(ctx.io.stderr, 'WARNING: this host echoed the invitation token (non-production). It is shown once; treat it like a password.');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const inv = res.body?.invite ?? {};
      writeLine(ctx.io.stdout, `Invited ${inv.email ?? options.email} as ${inv.role ?? options.role ?? 'viewer'} (${inv.inviteId ?? '?'}; delivery: ${res.body?.delivery ?? '?'}).`);
      if (res.body?.token) writeLine(ctx.io.stdout, `token: ${res.body.token}`);
      return 0;
    }
    case 'revoke':
    case 'delete': {
      if (positionals.length !== 1) { writeLine(ctx.io.stderr, 'Usage: openwop orgs invites <orgId> revoke <inviteId> --yes'); return 2; }
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to revoke invite ${positionals[0]} without --yes.`); return 2; }
      await requestJson(ctx, `${base}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      if (ctx.json) { writeJson(ctx.io.stdout, { inviteId: positionals[0], revoked: true }); return 0; }
      writeLine(ctx.io.stdout, `Revoked invite ${positionals[0]}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown invites verb: ${verb}`);
  }
}

async function runInvitations(ctx: Ctx, argv: string[]) {
  const verb = argv[0];
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--token'] });
  if (!verb || verb === '--help' || verb === '-h' || options.help || !['preview', 'accept', 'decline'].includes(verb)) {
    write(ctx.io.stdout, 'Usage: openwop orgs invitations preview|accept|decline [--token <t>] [--json]\n');
    return verb && verb !== '--help' && verb !== '-h' && !options.help ? 2 : 0;
  }
  let token: string = options.token ?? '';
  if (!token) {
    const entered = await readSecret(ctx, 'Invitation token: ');
    token = typeof entered === 'string' ? entered.trim() : '';
  }
  if (!token) throw new CliError('An invitation token is required (--token, or enter it when prompted).', 2);
  const res = verb === 'preview'
    ? await requestJson(ctx, `/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(token)}`)
    : await requestJson(ctx, `/host/openwop-app/orgs/invitations/${verb}`, { method: 'POST', body: { token } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  if (verb === 'preview') writeJson(ctx.io.stdout, b);
  else if (verb === 'accept') writeLine(ctx.io.stdout, b.alreadyMember ? `Already a member of org ${b.orgId ?? '?'}.` : `Joined org ${b.orgId ?? '?'} as member ${b.memberId ?? '?'}.`);
  else writeLine(ctx.io.stdout, 'Invitation declined.');
  return 0;
}

// ── nested entities (teams/groups/roles/members) ──────────────────────────
async function runEntity(ctx: Ctx, entity: Entity, argv: string[]) {
  const orgId = argv[0];
  const verb = argv[1] ?? 'list';
  if (!orgId || orgId === '--help' || orgId === '-h') {
    write(ctx.io.stdout, `Usage: openwop orgs ${entity} <orgId> list|create|update|delete [...]\n`);
    return orgId ? 0 : 2;
  }
  const rest = argv.slice(2);
  const base = `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/${entity}`;
  switch (verb) {
    case 'list': {
      const res = await requestJson(ctx, base);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = entity === 'roles'
        ? [...arrayOf(res.body, 'roles'), ...arrayOf(res.body, 'customRoles')]
        : arrayOf(res.body, entity);
      if (items.length === 0) { writeLine(ctx.io.stdout, `No ${entity} in org ${orgId}.`); return 0; }
      writeJson(ctx.io.stdout, items);
      return 0;
    }
    case 'create': {
      const { body, ok } = entityBody(ctx, entity, rest, true);
      if (!ok) return 2;
      const res = await requestJson(ctx, base, { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Created ${singular(entity)} in org ${orgId}.`);
      return 0;
    }
    case 'update': {
      const { positionals } = parseOptions(rest, { bool: ['--help'], value: passThroughValues(entity), multi: passThroughMulti(entity) });
      if (positionals.length !== 1) { writeLine(ctx.io.stderr, `Usage: openwop orgs ${entity} <orgId> update <${singular(entity)}Id> [...]`); return 2; }
      const { body, ok } = entityBody(ctx, entity, rest, false);
      if (!ok) return 2;
      const res = await requestJson(ctx, `${base}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Updated ${singular(entity)} ${positionals[0]}.`);
      return 0;
    }
    case 'delete': {
      const { options, positionals } = parseOptions(rest, { bool: ['--help', '--yes'] });
      if (options.help || positionals.length !== 1) { writeLine(ctx.io.stderr, `Usage: openwop orgs ${entity} <orgId> delete <${singular(entity)}Id> [--yes]`); return options.help ? 0 : 2; }
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete ${singular(entity)} ${positionals[0]} without --yes.`); return 2; }
      await requestJson(ctx, `${base}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted ${singular(entity)} ${positionals[0]}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown ${entity} verb: ${verb}`);
  }
}

function passThroughValues(entity: Entity): string[] {
  switch (entity) {
    case 'teams': return ['--name', '--description', '--color'];
    case 'groups': return ['--name', '--description'];
    case 'roles': return ['--name', '--description'];
    case 'members': return ['--subject', '--display-name', '--email'];
  }
}
function passThroughMulti(entity: Entity): string[] {
  switch (entity) {
    case 'groups': return ['--role', '--member'];
    case 'roles': return ['--scope'];
    case 'members': return ['--role', '--team'];
    default: return [];
  }
}

/** Build the request body for a nested-entity create/update from flags. */
function entityBody(ctx: Ctx, entity: Entity, argv: string[], requireName: boolean): { body: Record<string, any>; ok: boolean } {
  const { options } = parseOptions(argv, { bool: ['--help', '--yes'], value: passThroughValues(entity), multi: passThroughMulti(entity) });
  const body: Record<string, any> = {};
  const setIf = (k: string, v: any) => { if (v !== undefined) body[k] = v; };
  switch (entity) {
    case 'teams':
      setIf('name', options.name); setIf('description', options.description); setIf('color', options.color);
      break;
    case 'roles':
      setIf('name', options.name); setIf('description', options.description);
      if (Array.isArray(options.scope) && options.scope.length) body.scopes = options.scope;
      break;
    case 'groups':
      setIf('name', options.name); setIf('description', options.description);
      if (Array.isArray(options.role) && options.role.length) body.roles = options.role;
      if (Array.isArray(options.member) && options.member.length) body.memberIds = options.member;
      break;
    case 'members':
      setIf('subject', options.subject); setIf('displayName', options.displayName); setIf('email', options.email);
      if (typeof options.subject === 'string' && options.subject.startsWith('user:')) {
        writeLine(ctx.io.stderr, 'Warning: --subject user:… is deprecated for adding a person. Use `openwop orgs members <orgId> add-existing` (or `link` for an existing row). The host will refuse it later (openwop-app#5945).');
      }
      if (Array.isArray(options.role) && options.role.length) body.roles = options.role;
      if (Array.isArray(options.team) && options.team.length) body.teamIds = options.team;
      break;
  }
  if (requireName) {
    if (entity === 'members') {
      if (!body.displayName) { writeLine(ctx.io.stderr, 'members create requires --display-name.'); return { body, ok: false }; }
    } else if (!body.name) {
      writeLine(ctx.io.stderr, `${entity} create requires --name.`); return { body, ok: false };
    }
  } else if (Object.keys(body).length === 0) {
    writeLine(ctx.io.stderr, `Nothing to update — pass at least one field for ${entity}.`); return { body, ok: false };
  }
  return { body, ok: true };
}

function singular(entity: Entity): string {
  return entity === 'teams' ? 'team' : entity === 'groups' ? 'group' : entity === 'roles' ? 'role' : 'member';
}

function arrayOf(body: any, key: string): any[] {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  return [];
}
