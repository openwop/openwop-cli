import type { Ctx } from '../context.js';
/** `openwop profiles ...` — self-service user profile/persona surface (ADR 0005). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const PROFILES_HELP = `Usage:
  openwop profiles list [--json]
  openwop profiles get [<userId>] [--json]            (omit userId for your own — same as 'me')
  openwop profiles me [--json]
  openwop profiles activity [--limit <n>] [--status <s>] [--json]
  openwop profiles edit [--job-title <t>] [--department <t>] [--bio <t>] [--location <t>]
                        [--equipment <x>]... [--interests <x>]...
                        [--availability-status available|busy|away] [--timezone <tz>] [--hours-per-week <n>] [--json]
  openwop profiles skills set --skill <name=proficiency>... [--json]
  openwop profiles portfolio add --token <mediaToken> [--json]
  openwop profiles portfolio remove <mediaToken> [--json]
  openwop profiles pin <rosterId> [--json]
  openwop profiles unpin <rosterId> [--json]
  openwop profiles endorse <userId> <skill> [--json]
  openwop profiles unendorse <userId> <skill> [--json]

Self-service PERSONA: your job title, bio, contact, skills, availability, portfolio,
and pinned agents (ADR 0005). The host is the authority and renders the resolved view —
reads are visible to any signed-in tenant member; writes only ever touch YOUR OWN profile
(authority is intrinsic to the caller's resolved identity). Tenant-scoped throughout; a
foreign-tenant id reads as 404. Requires a durable signed-in account (bearer via --api-key).

BOUNDARY: \`profiles\` is the persona/skills surface, NOT the user directory (account
lifecycle lives in the host's users surface) and NOT RBAC (that's \`orgs\`). \`profiles list\`
is the persona directory of the tenant, not an account-management list.

  --job-title/--department/--bio/--location   (edit) Text fields; pass empty string to clear.
  --equipment/--interests <x>                 (edit) Repeatable; replaces the whole list.
  --availability-status / --timezone / --hours-per-week  (edit) Availability sub-fields.
  --skill <name=proficiency>                  (skills set) Repeatable; proficiency is 1..5. Replaces the skill list.
  --token <mediaToken>                        (portfolio add) A tenant media-asset token (must be an image).
  --limit <n> / --status <s>                  (activity) Page size (1..50) / run-status filter.

Exit codes: 0 success · 1 host/HTTP error (incl. not found / not signed in) · 2 usage error.

Examples:
  openwop profiles me
  openwop profiles get user_42 --json
  openwop profiles edit --job-title "Staff Engineer" --availability-status busy --timezone Europe/London
  openwop profiles skills set --skill TypeScript=5 --skill Rust=3
  openwop profiles endorse user_42 TypeScript
  openwop profiles pin r_123
  openwop profiles activity --limit 10 --status failed
`;

const BASE = '/v1/host/sample/profiles';

/** requestJson with profile-aware, fail-closed error mapping. */
async function profilesRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2], notFoundMsg?: string) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) {
        throw new CliError('profiles requires a durable signed-in account — pass a bearer token via --api-key.', 1);
      }
      if (err.status === 404 && notFoundMsg) {
        throw new CliError(notFoundMsg, 1);
      }
    }
    throw err;
  }
}

export async function runProfiles(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'me';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, PROFILES_HELP);
    return 0;
  }
  if (sub === 'portfolio') {
    const psub = argv[1] ?? '';
    const rest = argv.slice(2);
    if (psub === 'add') return await runPortfolioAdd(ctx, rest);
    if (psub === 'remove') return await runPortfolioRemove(ctx, rest);
    throw new CliError(`Unknown profiles portfolio command: ${psub || '(none)'}\nRun \`openwop profiles --help\` for usage.`);
  }
  if (sub === 'skills') {
    const psub = argv[1] ?? '';
    if (psub === 'set') return await runSkillsSet(ctx, argv.slice(2));
    throw new CliError(`Unknown profiles skills command: ${psub || '(none)'}\nRun \`openwop profiles --help\` for usage.`);
  }
  const args = argv.slice(1);
  switch (sub) {
    case 'list':
      return await runList(ctx, args);
    case 'get':
      return await runGet(ctx, args);
    case 'me':
      return await runGet(ctx, []); // self
    case 'activity':
      return await runActivity(ctx, args);
    case 'edit':
      return await runEdit(ctx, args);
    case 'pin':
      return await runPin(ctx, args, true);
    case 'unpin':
      return await runPin(ctx, args, false);
    case 'endorse':
      return await runEndorse(ctx, args, true);
    case 'unendorse':
      return await runEndorse(ctx, args, false);
    default:
      throw new CliError(`Unknown profiles command: ${sub}\nRun \`openwop profiles --help\` for usage.`);
  }
}

function renderProfile(ctx: Ctx, p: any): void {
  const out = ctx.io.stdout;
  const who = p.userId ?? '(unknown)';
  writeLine(out, `user: ${p.displayName ? `${p.displayName} (${who})` : who}`);
  if (p.jobTitle || p.department) writeLine(out, `role: ${[p.jobTitle, p.department].filter(Boolean).join(' · ')}`);
  if (p.bio) writeLine(out, `bio: ${p.bio}`);
  if (typeof p.completeness === 'number') writeLine(out, `completeness: ${p.completeness}%`);
  if (p.emailVerified !== undefined) writeLine(out, `emailVerified: ${p.emailVerified ? 'yes' : 'no'}`);
  if (Array.isArray(p.skills) && p.skills.length) {
    writeLine(out, `skills: ${p.skills.map((s: any) => `${s.name}(${s.proficiency})${Array.isArray(s.endorsements) && s.endorsements.length ? ` +${s.endorsements.length}` : ''}`).join(', ')}`);
  }
  if (p.availability && (p.availability.status || p.availability.timezone || p.availability.hoursPerWeek !== undefined)) {
    const a = p.availability;
    writeLine(out, `availability: ${[a.status, a.timezone, a.hoursPerWeek !== undefined ? `${a.hoursPerWeek}h/wk` : ''].filter(Boolean).join(' · ')}`);
  }
  if (p.contact && (p.contact.location || (Array.isArray(p.contact.links) && p.contact.links.length))) {
    const c = p.contact;
    if (c.location) writeLine(out, `location: ${c.location}`);
    if (Array.isArray(c.links) && c.links.length) writeLine(out, `links: ${c.links.map((l: any) => `${l.label || l.url}${l.label && l.url ? ` <${l.url}>` : ''}`).join(', ')}`);
  }
  if (Array.isArray(p.equipment) && p.equipment.length) writeLine(out, `equipment: ${p.equipment.join(', ')}`);
  if (Array.isArray(p.interests) && p.interests.length) writeLine(out, `interests: ${p.interests.join(', ')}`);
  if (Array.isArray(p.workflows) && p.workflows.length) writeLine(out, `workflows: ${p.workflows.join(', ')}`);
  if (Array.isArray(p.pinnedAgentIds) && p.pinnedAgentIds.length) writeLine(out, `pinnedAgents: ${p.pinnedAgentIds.join(', ')}`);
  if (Array.isArray(p.portfolioAssetTokens) && p.portfolioAssetTokens.length) writeLine(out, `portfolio: ${p.portfolioAssetTokens.length} asset(s)`);
  if (p.avatarAssetToken) writeLine(out, `avatar: set`);
}

async function runList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop profiles list [--json]\n'); return 0; }
  const res = await profilesRequest(ctx, BASE);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const profiles = Array.isArray(res.body?.profiles) ? res.body.profiles : [];
  if (profiles.length === 0) { writeLine(ctx.io.stdout, 'No profiles in this tenant.'); return 0; }
  const rows = profiles.map((p: any) => ({
    userId: p.userId,
    name: p.displayName ?? '',
    role: [p.jobTitle, p.department].filter(Boolean).join(' / '),
    skills: Array.isArray(p.skills) ? String(p.skills.length) : '0',
    complete: typeof p.completeness === 'number' ? `${p.completeness}%` : '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['userId', 'name', 'role', 'skills', 'complete']));
  return 0;
}

async function runGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length > 1) {
    write(ctx.io.stdout, 'Usage: openwop profiles get [<userId>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const path = positionals.length === 1 ? `${BASE}/${encodeURIComponent(positionals[0])}` : `${BASE}/me`;
  const res = await profilesRequest(ctx, path, undefined, `Profile not found: ${positionals[0] ?? 'me'}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  renderProfile(ctx, res.body ?? {});
  return 0;
}

async function runActivity(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--limit', '--status'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop profiles activity [--limit <n>] [--status <s>] [--json]\n'); return 0; }
  const qs = new URLSearchParams();
  if (options.limit !== undefined) qs.set('limit', String(options.limit));
  if (options.status !== undefined) qs.set('status', String(options.status));
  const q = qs.toString();
  const res = await profilesRequest(ctx, `${BASE}/me/activity${q ? `?${q}` : ''}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.items) ? res.body.items : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No recent activity.'); return 0; }
  const rows = items.map((it: any) => ({
    runId: it.runId ?? '',
    workflow: it.workflowId ?? it.workflow ?? '',
    status: it.status ?? '',
    when: it.createdAt ?? it.ts ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['runId', 'workflow', 'status', 'when']));
  if (res.body?.truncated) writeLine(ctx.io.stdout, '(activity scan truncated — narrow with --status or --limit)');
  return 0;
}

async function runEdit(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--job-title', '--department', '--bio', '--location', '--availability-status', '--timezone', '--hours-per-week'],
    multi: ['--equipment', '--interests'],
  });
  if (options.help) { write(ctx.io.stdout, PROFILES_HELP); return 0; }
  const body: Record<string, unknown> = {};
  if (options.jobTitle !== undefined) body.jobTitle = options.jobTitle;
  if (options.department !== undefined) body.department = options.department;
  if (options.bio !== undefined) body.bio = options.bio;
  if (Array.isArray(options.equipment)) body.equipment = options.equipment;
  if (Array.isArray(options.interests)) body.interests = options.interests;
  if (options.location !== undefined) body.contact = { location: options.location };
  const avail: Record<string, unknown> = {};
  if (options.availabilityStatus !== undefined) {
    if (!['available', 'busy', 'away'].includes(options.availabilityStatus)) {
      throw new CliError('--availability-status must be one of available, busy, away', 2);
    }
    avail.status = options.availabilityStatus;
  }
  if (options.timezone !== undefined) avail.timezone = options.timezone;
  if (options.hoursPerWeek !== undefined) {
    const h = Number(options.hoursPerWeek);
    if (!Number.isFinite(h)) throw new CliError('--hours-per-week must be a number', 2);
    avail.hoursPerWeek = h;
  }
  if (Object.keys(avail).length) body.availability = avail;
  if (Object.keys(body).length === 0) throw new CliError('Nothing to edit — pass at least one field.', 2);
  const res = await profilesRequest(ctx, `${BASE}/me`, { method: 'PATCH', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, 'Updated your profile.');
  renderProfile(ctx, res.body ?? {});
  return 0;
}

async function runSkillsSet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], multi: ['--skill'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop profiles skills set --skill <name=proficiency>... [--json]\n'); return 0; }
  const entries = Array.isArray(options.skill) ? options.skill : [];
  if (entries.length === 0) throw new CliError('Pass at least one --skill <name=proficiency>.', 2);
  const skills = entries.map((e: string) => {
    const eq = e.lastIndexOf('=');
    if (eq < 0) throw new CliError(`--skill must be name=proficiency (got '${e}')`, 2);
    const name = e.slice(0, eq).trim();
    const prof = Number(e.slice(eq + 1));
    if (!name) throw new CliError(`--skill name is required (got '${e}')`, 2);
    if (!Number.isFinite(prof) || prof < 1 || prof > 5) throw new CliError(`--skill proficiency must be 1..5 (got '${e}')`, 2);
    return { name, proficiency: prof };
  });
  const res = await profilesRequest(ctx, `${BASE}/me/skills`, { method: 'PUT', body: { skills } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Set ${skills.length} skill(s).`);
  renderProfile(ctx, res.body ?? {});
  return 0;
}

async function runPortfolioAdd(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--token'] });
  if (options.help || options.token === undefined) {
    write(ctx.io.stdout, 'Usage: openwop profiles portfolio add --token <mediaToken> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await profilesRequest(ctx, `${BASE}/me/portfolio`, { method: 'POST', body: { token: options.token } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, 'Added portfolio asset.');
  return 0;
}

async function runPortfolioRemove(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop profiles portfolio remove <mediaToken> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await profilesRequest(ctx, `${BASE}/me/portfolio/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' }, `Portfolio asset not found: ${positionals[0]}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, 'Removed portfolio asset.');
  return 0;
}

async function runPin(ctx: Ctx, argv: string[], pinned: boolean) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop profiles ${pinned ? 'pin' : 'unpin'} <rosterId> [--json]\n`);
    return options.help ? 0 : 2;
  }
  const path = `${BASE}/me/pinned-agents/${encodeURIComponent(positionals[0])}`;
  const res = await profilesRequest(ctx, path, { method: pinned ? 'PUT' : 'DELETE' }, `Agent not found: ${positionals[0]}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `${pinned ? 'Pinned' : 'Unpinned'} agent ${positionals[0]}.`);
  return 0;
}

async function runEndorse(ctx: Ctx, argv: string[], add: boolean) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, `Usage: openwop profiles ${add ? 'endorse' : 'unendorse'} <userId> <skill> [--json]\n`);
    return options.help ? 0 : 2;
  }
  const [userId, skill] = positionals;
  const path = `${BASE}/${encodeURIComponent(userId)}/skills/${encodeURIComponent(skill)}/endorse`;
  const res = await profilesRequest(ctx, path, { method: add ? 'POST' : 'DELETE' }, `Profile or skill not found: ${userId} / ${skill}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `${add ? 'Endorsed' : 'Removed endorsement for'} ${skill} on ${userId}.`);
  return 0;
}
