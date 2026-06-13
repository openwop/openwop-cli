import type { Ctx } from '../context.js';
/** `openwop governance ...` — tenant governance policy + audit view (ADR 0028). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const GOV_BASE = '/v1/host/sample/governance';

// Mirror the host wire enums EXACTLY (governanceService.ts / routes/governance.ts).
// These bound the CLI's input hygiene only — the host stays the policy authority.
const ACTION_KINDS = ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge'] as const;
const POLICY_VALUES = ['disabled', 'draft-only', 'approval-required'] as const;

export const GOVERNANCE_HELP = `Usage:
  openwop governance policy [get] [--json]
  openwop governance policy set [--provider-allowlist <a,b,...>] [--action <kind=policy>]... [--retention-graph-days <n>] [--retention-source-days <n>] [--json]
  openwop governance audit [--prefix <p>] [--limit <n>] [--since <iso>] [--json]

Tenant governance administration (ADR 0028, host extension — superadmin-gated).
Endpoints under ${GOV_BASE}:
  GET  /policy   the tenant's stored policy + the host's declared defaults
  PUT  /policy   upsert provider allowlist / per-action policy / retention (itself audited)
  GET  /audit    the read view over the host audit log (assistant decisions, policy edits)

CAPABILITY HONESTY: the HOST is the authority for every policy decision — this command
only RENDERS the host's resolved view (stored values + the host's declared defaults). It
never evaluates or asserts a policy outcome locally. Governance is a NON-NORMATIVE host
extension (not advertised in /.well-known/openwop); if the host does not expose the surface
the command fails closed legibly (exit 2) rather than guessing.

Action kinds : ${ACTION_KINDS.join(', ')}
Policy values: ${POLICY_VALUES.join(' | ')} (unset kinds fall back to the host's declared default)

  --provider-allowlist L   Comma-separated provider ids the tenant may connect/resolve.
                           Empty string restricts ALL providers; omit to leave unchanged.
  --action <kind=policy>   Set one action kind's policy (repeatable).
  --retention-graph-days N    Assistant-graph retention window (days).
  --retention-source-days N   Source-derived retention window (days).
  --prefix P               (audit) action-id prefix filter (host default: assistant.).
  --limit N                (audit) max rows (host default: 100).
  --since ISO              (audit) only rows at/after this ISO timestamp.

Exit codes: 0 ok · 2 usage error / surface not advertised / not authorized.

Examples:
  openwop governance policy
  openwop governance policy get --json
  openwop governance policy set --action email.send=approval-required --action nudge=disabled
  openwop governance policy set --provider-allowlist anthropic,openai --retention-graph-days 90
  openwop governance audit --prefix governance. --limit 20 --json
`;

// Probe + fail closed: a 404 means the host does not advertise the governance
// surface (NON-NORMATIVE extension). Render that legibly instead of leaking a bare
// HTTP 404 — never assume a policy when the host has not spoken.
async function govRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2]) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(
        'Host does not advertise governance administration (ADR 0028 host extension). Surface unavailable — failing closed.',
        2,
      );
    }
    throw err;
  }
}

export async function runGovernance(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'policy';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, GOVERNANCE_HELP);
    return 0;
  }
  switch (sub) {
    case 'policy':
      return await runGovernancePolicy(ctx, argv.slice(1));
    case 'audit':
      return await runGovernanceAudit(ctx, argv.slice(1));
    // `get`/`set` at the top level are policy ops — lets the `policy` group alias
    // read naturally (`openwop policy set ...`) without a redundant `policy policy`.
    case 'get':
    case 'set':
      return await runGovernancePolicy(ctx, argv);
    default:
      throw new CliError(`Unknown governance command: ${sub}\nRun \`openwop governance --help\` for usage.`);
  }
}

async function runGovernancePolicy(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'set' ? 'set' : 'get';
  const rest = argv[0] === 'get' || argv[0] === 'set' ? argv.slice(1) : argv;
  return action === 'set' ? await runPolicySet(ctx, rest) : await runPolicyGet(ctx, rest);
}

async function runPolicyGet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, GOVERNANCE_HELP);
    return 0;
  }
  const res = await govRequest(ctx, `${GOV_BASE}/policy`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const body = res.body ?? {};
  const policy = body.policy ?? {};
  const kinds: string[] = Array.isArray(body.actionKinds) ? body.actionKinds : [...ACTION_KINDS];
  const defaultPolicy = body.defaults?.actionPolicy;
  const stored: Record<string, string> = policy.actionPolicy ?? {};

  writeLine(ctx.io.stdout, `Governance policy — tenant ${policy.tenantId ?? '(default)'}`);
  writeLine(ctx.io.stdout, `Action policy (unset kinds default to '${defaultPolicy ?? '(host default)'}' — host-resolved):`);
  const rows = kinds.map((k) => ({
    kind: k,
    policy: stored[k] ?? `(default → ${defaultPolicy ?? '?'})`,
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['kind', 'policy']));
  const allowlist = policy.providerAllowlist;
  const allowlistText = Array.isArray(allowlist)
    ? allowlist.length
      ? allowlist.join(', ')
      : '(empty — all providers blocked)'
    : '(unset — all providers allowed)';
  writeLine(ctx.io.stdout, `Provider allowlist: ${allowlistText}`);
  const retention = policy.retention;
  if (retention && (retention.assistantGraphDays !== undefined || retention.sourceDerivedDays !== undefined)) {
    writeLine(ctx.io.stdout, `Retention: assistantGraphDays=${retention.assistantGraphDays ?? '—'} sourceDerivedDays=${retention.sourceDerivedDays ?? '—'}`);
  } else {
    writeLine(ctx.io.stdout, 'Retention: (unset)');
  }
  if (policy.updatedAt) writeLine(ctx.io.stdout, `Updated: ${policy.updatedAt}${policy.updatedByUserId ? ` by ${policy.updatedByUserId}` : ''}`);
  return 0;
}

async function runPolicySet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--provider-allowlist', '--retention-graph-days', '--retention-source-days'],
    multi: ['--action'],
  });
  if (options.help) {
    write(ctx.io.stdout, GOVERNANCE_HELP);
    return 0;
  }
  const body: Record<string, any> = {};

  if (options.providerAllowlist !== undefined) {
    body.providerAllowlist = String(options.providerAllowlist)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  if (Array.isArray(options.action) && options.action.length) {
    const actionPolicy: Record<string, string> = {};
    for (const entry of options.action) {
      const eq = String(entry).indexOf('=');
      if (eq < 0) throw new CliError(`--action must be <kind=policy>, got '${entry}'`, 2);
      const kind = entry.slice(0, eq).trim();
      const policy = entry.slice(eq + 1).trim();
      if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
        throw new CliError(`Unknown action kind '${kind}'. Known: ${ACTION_KINDS.join(', ')}`, 2);
      }
      if (!(POLICY_VALUES as readonly string[]).includes(policy)) {
        throw new CliError(`Policy for '${kind}' must be one of ${POLICY_VALUES.join(' | ')}`, 2);
      }
      actionPolicy[kind] = policy;
    }
    body.actionPolicy = actionPolicy;
  }

  const retention: Record<string, number> = {};
  for (const [flag, key] of [
    ['retentionGraphDays', 'assistantGraphDays'],
    ['retentionSourceDays', 'sourceDerivedDays'],
  ] as const) {
    if (options[flag] !== undefined) {
      const n = Number(options[flag]);
      if (!Number.isFinite(n) || n < 0) throw new CliError(`--${flag.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a non-negative number`, 2);
      retention[key] = n;
    }
  }
  if (Object.keys(retention).length) body.retention = retention;

  if (Object.keys(body).length === 0) {
    throw new CliError('Nothing to set — pass --provider-allowlist, --action, and/or --retention-*.', 2);
  }

  const res = await govRequest(ctx, `${GOV_BASE}/policy`, { method: 'PUT', body });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const policy = res.body?.policy ?? {};
  writeLine(ctx.io.stdout, `Updated governance policy for tenant ${policy.tenantId ?? '(default)'}.`);
  if (policy.actionPolicy) {
    for (const [k, v] of Object.entries(policy.actionPolicy)) writeLine(ctx.io.stdout, `  ${k} → ${v}`);
  }
  if (Array.isArray(policy.providerAllowlist)) {
    writeLine(ctx.io.stdout, `  providerAllowlist: ${policy.providerAllowlist.length ? policy.providerAllowlist.join(', ') : '(empty — all blocked)'}`);
  }
  return 0;
}

async function runGovernanceAudit(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--prefix', '--limit', '--since'],
  });
  if (options.help) {
    write(ctx.io.stdout, GOVERNANCE_HELP);
    return 0;
  }
  const qs = new URLSearchParams();
  if (options.prefix !== undefined) qs.set('actionPrefix', String(options.prefix));
  if (options.limit !== undefined) {
    const n = Number(options.limit);
    if (!Number.isFinite(n) || n < 0) throw new CliError('--limit must be a non-negative number', 2);
    qs.set('limit', String(n));
  }
  if (options.since !== undefined) qs.set('since', String(options.since));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';

  const res = await govRequest(ctx, `${GOV_BASE}/audit${suffix}`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const items = Array.isArray(res.body?.items) ? res.body.items : [];
  if (items.length === 0) {
    writeLine(ctx.io.stdout, 'No audit rows match (tenant-scoped; rows without a tenant stamp are withheld).');
    return 0;
  }
  const rows = items.map((r: any) => ({
    timestamp: r.timestamp ?? '',
    principal: r.principalId ?? '',
    action: r.action ?? '',
    resource: r.resource ?? '',
    outcome: r.outcome ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['timestamp', 'principal', 'action', 'resource', 'outcome']));
  return 0;
}
