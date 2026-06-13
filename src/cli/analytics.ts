import type { Ctx } from '../context.js';
/** `openwop analytics ...` (alias `usage`) — org-scoped usage analytics reads (ADR 0018). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const ANALYTICS_BASE = '/v1/host/sample/analytics/orgs';
const PUBLIC_BASE = '/v1/host/sample/public-analytics';

// Mirror the host wire enum EXACTLY (analyticsService.ts EVENT_TYPES).
const EVENT_TYPES = ['pageview', 'event', 'conversion'] as const;

export const ANALYTICS_HELP = `Usage:
  openwop analytics summary <orgId> [--json]
  openwop analytics events <orgId> [--json]
  openwop analytics collect <orgId> --session <key> [--type <t>] [--path <p>] [--name <n>] [--prop k=v]... [--json]

Org-scoped usage analytics (ADR 0018 host extension). Aliased as \`usage\`.
Endpoints:
  GET  ${ANALYTICS_BASE}/:orgId/summary   aggregate usage rollup     [authed, workspace:read]
  GET  ${ANALYTICS_BASE}/:orgId/events    recent raw events (max 100) [authed, workspace:read]
  POST ${PUBLIC_BASE}/:orgId/collect              record one event           [PUBLIC, unauthed]

This is USAGE / cost / observability — distinct from \`governance audit\` (the policy-decision
log). The HOST is the authority: it aggregates server-side and gates each org read by RBAC
(workspace:read) + the org-tenant's \`analytics\` toggle. This command only RENDERS what the
host returns; it never computes a rollup locally. When analytics isn't served the host returns
a uniform 404 and the command fails closed legibly (exit 2).

The public \`collect\` beacon is consent-gated host-side (ADR 0020): a 201 records the event;
a 202 means analytics consent wasn't granted (honestly reported, not recorded). It is sent
WITHOUT auth (public path) — no bearer is attached.

  --session <key>   (collect) The visitor session key (== the consent subject key). Required.
  --type <t>        (collect) Event type: ${EVENT_TYPES.join(' | ')} (host default: event).
  --path <p>        (collect) Page path (for pageviews).
  --name <n>        (collect) Event name.
  --prop k=v        (collect) A typed property (repeatable; v parsed as number/bool/string).
  --json            Emit the raw host JSON.

Exit codes: 0 ok · 1 host error · 2 usage error / analytics not served / not authorized.

Examples:
  openwop analytics summary org_123
  openwop usage events org_123 --json
  openwop analytics collect org_123 --session s_abc --type pageview --path /pricing
`;

// Probe + fail closed: a 404 means the host doesn't serve analytics for this org (toggle off /
// unknown org) — render that legibly instead of a bare HTTP 404.
async function analyticsRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2]) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(
        `Host does not serve analytics for this org (ADR 0018 — the org-tenant's 'analytics' toggle is off, or the org is unknown). Failing closed.`,
        2,
      );
    }
    throw err;
  }
}

export async function runAnalytics(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'summary';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, ANALYTICS_HELP);
    return 0;
  }
  switch (sub) {
    case 'summary':
      return await runSummary(ctx, argv.slice(1));
    case 'events':
      return await runEvents(ctx, argv.slice(1));
    case 'collect':
      return await runCollect(ctx, argv.slice(1));
    default:
      throw new CliError(`Unknown analytics command: ${sub}\nRun \`openwop analytics --help\` for usage.`);
  }
}

async function runSummary(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop analytics summary <orgId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await analyticsRequest(ctx, `${ANALYTICS_BASE}/${encodeURIComponent(positionals[0])}/summary`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const s = res.body?.summary ?? {};
  writeLine(ctx.io.stdout, `total events: ${s.total ?? 0}`);
  writeLine(ctx.io.stdout, `sessions: ${s.sessions ?? 0}`);
  const byType = s.byType ?? {};
  writeLine(ctx.io.stdout, `by type: ${EVENT_TYPES.map((t) => `${t}=${byType[t] ?? 0}`).join('  ')}`);
  if (Array.isArray(s.topPaths) && s.topPaths.length) {
    writeLine(ctx.io.stdout, 'top paths:');
    for (const p of s.topPaths) writeLine(ctx.io.stdout, `  ${p.count}\t${p.path}`);
  }
  if (Array.isArray(s.utmSources) && s.utmSources.length) {
    writeLine(ctx.io.stdout, 'utm sources:');
    for (const u of s.utmSources) writeLine(ctx.io.stdout, `  ${u.count}\t${u.source}`);
  }
  return 0;
}

async function runEvents(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop analytics events <orgId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await analyticsRequest(ctx, `${ANALYTICS_BASE}/${encodeURIComponent(positionals[0])}/events`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const events = Array.isArray(res.body?.events) ? res.body.events : [];
  if (events.length === 0) {
    writeLine(ctx.io.stdout, 'No analytics events for this org.');
    return 0;
  }
  const rows = events.map((e: any) => ({
    ts: e.ts ?? '',
    type: e.type ?? '',
    path: e.path ?? e.name ?? '',
    session: e.sessionKey ?? '',
    eventId: e.eventId ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['ts', 'type', 'path', 'session', 'eventId']));
  return 0;
}

async function runCollect(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--session', '--type', '--path', '--name'],
    multi: ['--prop'],
  });
  if (options.help || positionals.length !== 1 || !options.session) {
    write(ctx.io.stdout, 'Usage: openwop analytics collect <orgId> --session <key> [--type <t>] [--path <p>] [--name <n>] [--prop k=v]... [--json]\n');
    return options.help ? 0 : 2;
  }
  if (options.type !== undefined && !(EVENT_TYPES as readonly string[]).includes(options.type)) {
    throw new CliError(`--type must be one of ${EVENT_TYPES.join(', ')}`, 2);
  }
  const body: Record<string, any> = { sessionKey: options.session };
  if (options.type !== undefined) body.type = options.type;
  if (options.path !== undefined) body.path = options.path;
  if (options.name !== undefined) body.name = options.name;
  if (Array.isArray(options.prop) && options.prop.length) {
    const props: Record<string, string | number | boolean> = {};
    for (const entry of options.prop) {
      const eq = String(entry).indexOf('=');
      if (eq < 0) throw new CliError(`--prop must be <key=value>, got '${entry}'`, 2);
      const k = entry.slice(0, eq);
      const raw = entry.slice(eq + 1);
      props[k] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) && raw.trim() !== '' ? Number(raw) : raw;
    }
    body.props = props;
  }
  // PUBLIC beacon — sent WITHOUT auth (public path, no bearer attached).
  const res = await analyticsRequest(ctx, `${PUBLIC_BASE}/${encodeURIComponent(positionals[0])}/collect`, {
    method: 'POST',
    body,
    auth: false,
  });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const r = res.body ?? {};
  if (r.recorded) {
    writeLine(ctx.io.stdout, `Recorded event ${r.eventId ?? ''}.`);
  } else {
    // Host-honest 202: analytics consent wasn't granted for this subject.
    writeLine(ctx.io.stdout, `Not recorded — ${r.reason === 'consent' ? 'analytics consent not granted for this session' : (r.reason ?? 'declined by host')}.`);
  }
  return 0;
}
