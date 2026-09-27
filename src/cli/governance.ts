import type { Ctx } from '../context.js';
/** `openwop governance ...` — tenant governance policy + audit view (ADR 0028). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gatedRequest, readBodyOption, parseBool } from './adminShared.js';

const GOV_BASE = '/v1/host/openwop-app/governance';

// Mirror the host wire enums EXACTLY (governanceService.ts / routes/governance.ts).
// These bound the CLI's input hygiene only — the host stays the policy authority.
const ACTION_KINDS = ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge'] as const;
const POLICY_VALUES = ['disabled', 'draft-only', 'approval-required'] as const;

export const GOVERNANCE_HELP = `Usage:
  openwop governance policy [get] [--json]
  openwop governance policy set [--provider-allowlist <a,b,...>] [--action <kind=policy>]...
                                [--retention-pii-days <n>] [--retention-internal-days <n>]
                                [--require-mfa true|false] [--body <json> | --body-file <path>] [--json]
  openwop governance audit [--prefix <p>] [--limit <n>] [--since <iso>] [--format csv|jsonl [--out <file>]] [--json]
  openwop governance audit-export [--format jsonl|csv] [--out <file>]
  openwop governance media-budget [get] [--json]
  openwop governance media-budget set [--tts-chars <n>] [--stt-bytes <n>] [--images <n>] [--video-jobs <n>] [--json]
  openwop governance byok-chat-budget [get] [--provider <id>] [--json]
  openwop governance byok-chat-budget set [--daily-token-cap <n|clear>] [--soft-warning-pct <n|clear>] [--json]
  openwop governance egress-rules [get] [--json]
  openwop governance egress-rules set --mode off|allowlist|denylist [--host <h>]... [--json]

Tenant governance administration (ADR 0028, host extension — superadmin-gated).
Endpoints under ${GOV_BASE}:
  GET  /policy   the tenant's stored policy + the host's declared defaults
  PUT  /policy   upsert provider allowlist / per-action policy / retention (itself audited)
  GET  /audit    the read view over the host audit log (assistant decisions, policy edits);
                 --format csv|jsonl downloads the same scoped rows
  GET  /audit/export  the workspace's tamper-evident audit CHAIN with an integrity proof
                 (jsonl line 1 = proof; csv carries it in x-audit-* headers) — needs
                 host:members:manage, NOT super-admin
  GET/PUT /media-budget      per-workspace media generation budget override
  GET/PUT /byok-chat-budget  per-workspace BYOK chat daily token cap (0 = uncapped; 'clear' = env default)
  GET/PUT /egress-rules      per-workspace outbound-host firewall layered on the SSRF baseline
                             (off | allowlist | denylist; a host matches itself + subdomains)

Every route except audit-export is SUPER-ADMIN gated: without a super-admin principal the
command fails closed with exit 4 and says how to get one (OPENWOP_SUPERADMIN_TENANTS).

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
  --retention-pii-days N       Confidential/PII retention window (days) — enforced by the host sweep.
  --retention-internal-days N  Internal-data retention window (days) — enforced by the host sweep.
  --require-mfa true|false     Require an MFA-verified session for this workspace.
  --body / --body-file         Extra policy fields merged into the PUT body (e.g. adSpend,
                               commerce, brandCompliance — see the host's policy contract).
  --retention-graph-days / --retention-source-days  DEPRECATED: the host ignores these two
                               windows (nothing enforces them) and answers with a warning,
                               which this command prints.
  --prefix P               (audit) action-id prefix filter (host default: assistant.).
  --limit N                (audit) max rows (host default: 100).
  --since ISO              (audit) only rows at/after this ISO timestamp.

  --format / --out         (audit, audit-export) download format and output file (default stdout).

Exit codes: 0 ok · 2 usage error / surface not advertised · 4 not a super-admin / not authorized.

Examples:
  openwop governance policy
  openwop governance policy get --json
  openwop governance policy set --action email.send=approval-required --action nudge=disabled
  openwop governance policy set --provider-allowlist anthropic,openai --retention-graph-days 90
  openwop governance audit --prefix governance. --limit 20 --json
  openwop governance audit-export --out audit-chain.jsonl
  openwop governance egress-rules set --mode allowlist --host api.stripe.com --host slack.com
  openwop governance byok-chat-budget set --daily-token-cap 200000 --soft-warning-pct 75
`;

// Probe + fail closed: a 404 means the host does not advertise the governance
// surface (NON-NORMATIVE extension). Render that legibly instead of leaking a bare
// HTTP 404 — never assume a policy when the host has not spoken.
async function govRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2]) {
  try {
    return await gatedRequest(ctx, path, options, 'Governance administration', 'superadmin');
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
    case 'media-budget':
      return await runGovernanceMediaBudget(ctx, argv.slice(1));
    case 'byok-chat-budget':
      return await runGovernanceByokBudget(ctx, argv.slice(1));
    case 'egress-rules':
      return await runGovernanceEgress(ctx, argv.slice(1));
    case 'audit-export':
      return await runGovernanceAuditExport(ctx, argv.slice(1));
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
    value: ['--provider-allowlist', '--retention-graph-days', '--retention-source-days', '--retention-pii-days', '--retention-internal-days', '--require-mfa', '--body', '--body-file'],
    multi: ['--action'],
  });
  if (options.help) {
    write(ctx.io.stdout, GOVERNANCE_HELP);
    return 0;
  }
  const body: Record<string, any> = { ...(readBodyOption(ctx, options) ?? {}) };

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
    ['retentionPiiDays', 'confidentialPiiDays'],
    ['retentionInternalDays', 'internalDays'],
  ] as const) {
    if (options[flag] !== undefined) {
      const n = Number(options[flag]);
      if (!Number.isFinite(n) || n < 0) throw new CliError(`--${flag.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a non-negative number`, 2);
      retention[key] = n;
    }
  }
  if (Object.keys(retention).length) body.retention = { ...(body.retention ?? {}), ...retention };
  if (options.requireMfa !== undefined) body.requireMfa = parseBool('--require-mfa', options.requireMfa);

  if (Object.keys(body).length === 0) {
    throw new CliError('Nothing to set — pass --provider-allowlist, --action, --retention-*, --require-mfa, or --body.', 2);
  }

  const res = await govRequest(ctx, `${GOV_BASE}/policy`, { method: 'PUT', body });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const policy = res.body?.policy ?? {};
  for (const w of Array.isArray(res.body?.warnings) ? res.body.warnings : []) {
    writeLine(ctx.io.stderr, `warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  }
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
    value: ['--prefix', '--limit', '--since', '--format', '--out'],
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
  if (options.format !== undefined) {
    if (options.format !== 'csv' && options.format !== 'jsonl') throw new CliError('--format must be csv or jsonl', 2);
    qs.set('format', String(options.format));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';

  const res = await govRequest(ctx, `${GOV_BASE}/audit${suffix}`);
  if (options.format !== undefined) return emitDownload(ctx, res.body, options.out);
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

/** GET/PUT ${GOV_BASE}/media-budget (ADR 0106) — the media-generation budget
 *  (TTS chars / STT bytes). `set` upserts the override; `get` shows the effective
 *  budgets. The host stays the authority — the CLI only renders + relays. */
async function runGovernanceMediaBudget(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'set' ? 'set' : 'get';
  const rest = argv[0] === 'get' || argv[0] === 'set' ? argv.slice(1) : argv;
  const path = `${GOV_BASE}/media-budget`;
  if (action === 'set') {
    const { options } = parseOptions(rest, { value: ['--tts-chars', '--stt-bytes', '--images', '--video-jobs'] });
    const body: Record<string, number> = {};
    if (options.ttsChars !== undefined) body.ttsChars = Number(options.ttsChars);
    if (options.sttBytes !== undefined) body.sttBytes = Number(options.sttBytes);
    if (options.images !== undefined) body.images = Number(options.images);
    if (options.videoJobs !== undefined) body.videoJobs = Number(options.videoJobs);
    const res = await govRequest(ctx, path, { method: 'PUT', body });
    if (ctx.json) writeJson(ctx.io.stdout, res.body);
    else writeLine(ctx.io.stdout, 'Media budget updated.');
    return 0;
  }
  const res = await govRequest(ctx, path);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `override:  ${b.override ? JSON.stringify(b.override) : '(none — using host defaults)'}`);
  writeLine(ctx.io.stdout, `effective: tts ${b.budgets?.ttsChars ?? '?'} chars/day, stt ${b.budgets?.sttBytes ?? '?'} bytes/day`);
  return 0;
}

/** Write a downloaded (non-JSON) body to --out or stdout. requestJson hands a non-JSON body
 *  back as {raw}; a single JSON line parses, so it is re-serialized. */
function emitDownload(ctx: Ctx, body: any, out: unknown): number {
  const text = typeof body?.raw === 'string' ? body.raw : body == null ? '' : `${JSON.stringify(body)}\n`;
  if (out !== undefined) {
    writeFileSync(resolve(ctx.cwd, String(out)), text);
    writeLine(ctx.io.stderr, `Wrote ${text.length} bytes to ${out}.`);
  } else {
    write(ctx.io.stdout, text);
  }
  return 0;
}

/** GET ${GOV_BASE}/audit/export — the tenant's audit chain + integrity proof (host:members:manage). */
async function runGovernanceAuditExport(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--format', '--out'] });
  if (options.help) { write(ctx.io.stdout, GOVERNANCE_HELP); return 0; }
  const format = options.format ?? 'jsonl';
  if (format !== 'csv' && format !== 'jsonl') throw new CliError('--format must be jsonl or csv', 2);
  const res = await gatedRequest(ctx, `${GOV_BASE}/audit/export${format === 'csv' ? '?format=csv' : ''}`, undefined, 'Exporting the audit chain', 'scope');
  if (format === 'csv') {
    const verified = res.headers.get('x-audit-verified');
    writeLine(ctx.io.stderr, `proof: head seq ${res.headers.get('x-audit-head-seq') ?? '?'} hash ${res.headers.get('x-audit-head-hash') || '(none)'} verified=${verified ?? '?'}`);
  }
  return emitDownload(ctx, res.body, options.out);
}

/** GET/PUT ${GOV_BASE}/byok-chat-budget (ADR 0178) — per-workspace BYOK chat token cap. */
async function runGovernanceByokBudget(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'set' ? 'set' : 'get';
  const rest = argv[0] === 'get' || argv[0] === 'set' ? argv.slice(1) : argv;
  const path = `${GOV_BASE}/byok-chat-budget`;
  const { options } = parseOptions(rest, { bool: ['--help'], value: ['--provider', '--daily-token-cap', '--soft-warning-pct'] });
  if (options.help) { write(ctx.io.stdout, GOVERNANCE_HELP); return 0; }
  if (action === 'set') {
    const body: Record<string, number | null> = {};
    const num = (flag: string, v: unknown) => {
      if (v === 'clear' || v === 'null') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new CliError(`${flag} must be a non-negative number or 'clear'`, 2);
      return n;
    };
    if (options.dailyTokenCap !== undefined) body.dailyTokenCap = num('--daily-token-cap', options.dailyTokenCap);
    if (options.softWarningPct !== undefined) body.softWarningPct = num('--soft-warning-pct', options.softWarningPct);
    if (Object.keys(body).length === 0) throw new CliError('Nothing to set — pass --daily-token-cap and/or --soft-warning-pct.', 2);
    const res = await govRequest(ctx, path, { method: 'PUT', body });
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    writeLine(ctx.io.stdout, `BYOK chat budget: ${res.body?.budget?.dailyTokenCap ? `${res.body.budget.dailyTokenCap} tokens/day` : 'uncapped'}, warn at ${res.body?.budget?.softWarningPct ?? '?'}%.`);
    return 0;
  }
  const q = options.provider ? `?provider=${encodeURIComponent(options.provider)}` : '';
  const res = await govRequest(ctx, `${path}${q}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `effective: ${b.budget?.dailyTokenCap ? `${b.budget.dailyTokenCap} tokens/day` : 'uncapped'} (warn at ${b.budget?.softWarningPct ?? '?'}%)`);
  writeLine(ctx.io.stdout, `override:  ${b.override ? JSON.stringify(b.override) : '(none — env default)'}`);
  if (b.provider) writeLine(ctx.io.stdout, `usage ${b.date} (${b.provider}): in ${b.usage?.inputTokens ?? 0} / out ${b.usage?.outputTokens ?? 0} tokens`);
  return 0;
}

const EGRESS_MODES = ['off', 'allowlist', 'denylist'] as const;

/** GET/PUT ${GOV_BASE}/egress-rules (ADR 0187) — per-workspace outbound firewall. */
async function runGovernanceEgress(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'set' ? 'set' : 'get';
  const rest = argv[0] === 'get' || argv[0] === 'set' ? argv.slice(1) : argv;
  const path = `${GOV_BASE}/egress-rules`;
  const { options } = parseOptions(rest, { bool: ['--help'], value: ['--mode'], multi: ['--host'] });
  if (options.help) { write(ctx.io.stdout, GOVERNANCE_HELP); return 0; }
  let res;
  if (action === 'set') {
    if (!(EGRESS_MODES as readonly string[]).includes(options.mode)) throw new CliError(`--mode must be one of ${EGRESS_MODES.join(' | ')}`, 2);
    // PUT replaces both fields — omitting --host sends an empty list (the host's contract).
    res = await govRequest(ctx, path, { method: 'PUT', body: { mode: options.mode, hosts: Array.isArray(options.host) ? options.host : [] } });
  } else {
    res = await govRequest(ctx, path);
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const hosts: string[] = Array.isArray(res.body?.hosts) ? res.body.hosts : [];
  writeLine(ctx.io.stdout, `mode:  ${res.body?.mode ?? '?'}`);
  writeLine(ctx.io.stdout, `hosts: ${hosts.length ? hosts.join(', ') : '(none)'}`);
  return 0;
}
