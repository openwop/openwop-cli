import type { Ctx } from '../context.js';
/** `openwop approvals ...` — the human side of "agents propose, humans dispose".
 *
 * Drives the host's approval inbox (sample host-extension, non-normative):
 *   GET  /v1/host/openwop-app/approvals[?status=pending|approved|rejected]
 *   POST /v1/host/openwop-app/approvals/{id}/claim   — affirmative sign-off (starts the run)
 *   POST /v1/host/openwop-app/approvals/{id}/reject  — dismiss the proposal
 *
 * Capability honesty is the whole point of this group: the HOST is the authority
 * for every policy decision. The CLI only RENDERS the host's resolved queue and
 * relays the human's claim/reject — it never computes or asserts an approval
 * outcome locally. We gate on the host's advertisement and fail closed legibly
 * when the surface isn't offered.
 *
 * Boundary vs `interrupts`: interrupts are run-level HITL tokens (resume a paused
 * run by token); approvals are the policy-gated action queue (a review-mode
 * member's heartbeat queued a proposal that a human must claim before it runs).
 */
import { CliError, HttpError } from '../errors.js';
import { hostSurfaceAdvertised } from '../protocol.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

/** Per-user Microsoft Teams approval delivery (host-extension, self-scoped: YOUR preference only). */
export const APPROVALS_ROUTES: RouteCmd[] = [
  { words: ['teams-pref'], method: 'GET', path: '/v1/host/openwop-app/approval-delivery/teams', summary: 'Where your approval requests are delivered in Teams (null = not set).' },
  { words: ['teams-pref', 'set'], method: 'PUT', path: '/v1/host/openwop-app/approval-delivery/teams', summary: 'Deliver your approval requests to a Teams chat through one of your connections.',
    body: [{ flag: '--connection-id', key: 'connectionId', required: true }, { flag: '--chat-id', key: 'chatId', required: true }] },
  { words: ['teams-pref', 'clear'], method: 'DELETE', path: '/v1/host/openwop-app/approval-delivery/teams', confirm: false, summary: 'Stop Teams delivery of your approval requests.' },
];

export const APPROVALS_HELP = `Usage:
  openwop approvals list [--status pending|approved|rejected] [--json]
  openwop approvals get <approvalId> [--json]
  openwop approvals claim <approvalId> [--note <text>] [--acted-for <subject>] [--expected-hash <h>] [--content-hash <h>] [--json]
  openwop approvals reject <approvalId> [--note <text>] [--acted-for <subject>] [--expected-hash <h>] [--content-hash <h>] [--json]
  openwop approvals sla-policy [--json]
  openwop approvals sla-policy set (--enabled | --disabled) [--remind-after-ms n] [--escalate-after-ms n] [--expire-after-ms n] [--json]
  openwop approvals email-pref [--json]
  openwop approvals email-pref set --email <addr> (--enabled | --disabled) [--json]
  openwop approvals delegations list [--all] [--json]
  openwop approvals delegations create --to <subject> --starts-at <iso> --ends-at <iso> [--from <subject>] [--reason <t>] [--json]
  openwop approvals delegations revoke <delegationId> [--json]

The approval inbox — the human side of "agents propose, humans dispose". A
review-mode roster member's heartbeat queues a proposal instead of starting the
run; these commands let a human resolve it. A CLAIM is the affirmative act: it
starts the proposed run (replay/fork/observability inherited). A REJECT dismisses
the proposal so the heartbeat won't re-propose it.

The host is the authority for every decision — the CLI renders the host's
resolved queue and relays your claim/reject; it never decides locally. If the
host does not advertise the approval surface (/.well-known/openwop), the group
fails closed rather than guessing.

Endpoints:
  list    GET  /v1/host/openwop-app/approvals[?status=...]
  get     GET  /v1/host/openwop-app/approvals   (filtered to <approvalId> client-side;
          the host exposes no single-approval GET)
  claim   POST /v1/host/openwop-app/approvals/{id}/claim
  reject  POST /v1/host/openwop-app/approvals/{id}/reject
  sla-policy        GET/PUT /v1/host/openwop-app/approvals/sla-policy (ADR 0478; the tenant's
                    remind → escalate → expire timers. PUT needs an admin role — exit 4 otherwise.
                    'set' reads the current policy first and sends it back with your changes.)
  email-pref        GET/PUT /v1/host/openwop-app/approvals/email-pref (your own opt-in to decide
                    approvals from email; needs a signed-in user)
  delegations       GET/POST /v1/host/openwop-app/approval-delegations and
                    POST …/approval-delegations/{id}/revoke (ADR 0198; you delegate YOUR
                    approvals to someone for a window; --all and --from are operator-only)

  --acted-for <s>      (claim/reject) As a delegate covering several people, whose approval this is.
  --expected-hash <h>  (claim/reject) The definition hash you reviewed (composed-workflow proposals;
                       the host refuses the decision if the proposal changed since).
  --content-hash <h>   (claim/reject) The contentHash of the assistant-action card you reviewed
                       (\`approvals get\` prints it under the card). REQUIRED to claim an
                       assistant action (ADR 0862): the host refuses a claim without it (exit 2),
                       and refuses one whose action changed since you read it (exit 1; re-read
                       it with \`approvals get\` and review the new card).
  --status <s>   (list) Filter the queue: pending | approved | rejected (default: all).
  --note <text>  (claim/reject) Optional human note recorded with the decision.
  --json         Print the raw host response instead of the rendered view.

Boundary: this is NOT \`interrupts\`. Interrupts are run-level HITL tokens you
resolve to resume a paused run; approvals are the policy-gated proposal queue.

Exit codes (get/claim/reject reflect the approval's resulting status, so scripts
can gate on the verdict):
  0  approved        3  pending        1  rejected (denied) or error
\`list\` exits 0 on success.

Examples:
  openwop approvals list --status pending
  openwop approvals get appr_123 --json
  openwop approvals claim appr_123 --note "LGTM, ship it"
  openwop approvals get appr_456                      # an assistant action: read the card
  openwop approvals claim appr_456 --content-hash 9f2c…   # …then approve exactly what you read
  openwop approvals reject appr_123 --note "out of policy"

Teams approval delivery:
${routesHelp('approvals', APPROVALS_ROUTES)}
`;

const SUBCOMMANDS = ['list', 'get', 'claim', 'reject', 'approve', 'deny', 'sla-policy', 'email-pref', 'delegations'];

export async function runApprovals(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, APPROVALS_HELP);
    return 0;
  }
  const ext = await dispatchRoutes(ctx, 'approvals', APPROVALS_ROUTES, argv);
  if (ext !== undefined) return ext;
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list':
      return await runApprovalsList(ctx, args);
    case 'get':
      return await runApprovalsGet(ctx, args);
    // `claim`/`reject` are the host's wire verbs; `approve`/`deny` are friendly aliases.
    case 'claim':
    case 'approve':
      return await runApprovalsResolve(ctx, args, 'claim');
    case 'reject':
    case 'deny':
      return await runApprovalsResolve(ctx, args, 'reject');
    case 'sla-policy':
      return await runApprovalsSlaPolicy(ctx, args);
    case 'email-pref':
      return await runApprovalsEmailPref(ctx, args);
    case 'delegations':
      return await runApprovalsDelegations(ctx, args);
    default:
      throw new CliError(`Unknown approvals command: ${sub}\nRun \`openwop approvals --help\` for usage.`);
  }
}

/** 0 approved · 3 pending · 1 rejected(denied)/unknown — the architect-specified
 *  contract, applied uniformly so `get`/`claim`/`reject` report the same verdict. */
function exitForStatus(status: unknown): number {
  if (status === 'approved') return 0;
  if (status === 'pending') return 3;
  return 1; // rejected / denied / anything unexpected
}

/** Capability honesty: confirm the host advertises the approval surface before
 *  we drive it. A reachable discovery doc that omits it ⇒ fail closed. An
 *  unreachable/absent discovery doc is inconclusive (not a denial) — defer to
 *  the live call's 404 translation rather than blocking a host that simply
 *  doesn't serve /.well-known/openwop. */
async function ensureApprovalsAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return; // can't prove absence — let the real request decide
  const advertised = hostSurfaceAdvertised(wk.body, '/v1/host/openwop-app/approvals');
  if (!advertised) {
    throw new CliError(
      'approvals: this host does not advertise the approval-inbox surface (/v1/host/openwop-app/approvals is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
      1,
    );
  }
}

/** Translate an absent/missing route into a capability-honest, fail-closed
 *  message. 404 means the surface isn't mounted or the id doesn't exist. */
function gate404(err: unknown): never {
  if (err instanceof HttpError && err.status === 404) {
    const detail =
      err.body && typeof err.body === 'object' && typeof (err.body as { message?: string }).message === 'string'
        ? (err.body as { message?: string }).message
        : 'not found';
    throw new CliError(
      `approvals: ${detail} (the host must mount /v1/host/openwop-app/approvals; the CLI renders the host's queue, it never decides).`,
      1,
    );
  }
  throw err;
}

async function fetchQueue(ctx: Ctx, status?: string): Promise<any[]> {
  const path = status ? `/v1/host/openwop-app/approvals?status=${encodeURIComponent(status)}` : '/v1/host/openwop-app/approvals';
  let res;
  try {
    res = await requestJson(ctx, path);
  } catch (err) {
    gate404(err);
  }
  return Array.isArray(res!.body?.items) ? res!.body.items : [];
}

async function runApprovalsList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--status'] });
  if (options.help) {
    write(ctx.io.stdout, APPROVALS_HELP);
    return 0;
  }
  if (options.status !== undefined && !['pending', 'approved', 'rejected'].includes(options.status)) {
    throw new CliError('--status must be one of: pending, approved, rejected', 2);
  }
  await ensureApprovalsAdvertised(ctx);
  const items = await fetchQueue(ctx, options.status);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { items });
    return 0;
  }
  if (items.length === 0) {
    writeLine(ctx.io.stdout, `No approvals${options.status ? ` with status ${options.status}` : ''} on this host.`);
    return 0;
  }
  const rows = items.map((a: any) => ({
    approvalId: a.approvalId,
    status: a.status,
    kind: a.kind ?? (a.actionId ? 'assistant-action' : 'run-proposal'),
    persona: a.persona ?? '',
    proposal: truncate(a.cardTitle ?? a.proposal ?? '', 40),
    createdAt: a.createdAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['approvalId', 'status', 'kind', 'persona', 'proposal', 'createdAt']));
  return 0;
}

async function runApprovalsGet(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop approvals get <approvalId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureApprovalsAdvertised(ctx);
  // The host exposes no single-approval GET — fetch the queue and select the
  // row. The host still owns the data; the CLI only filters its resolved view.
  const items = await fetchQueue(ctx);
  const approval = items.find((a: any) => a.approvalId === positionals[0]);
  if (!approval) {
    throw new CliError(`approvals: no approval found with id ${positionals[0]}.`, 1);
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, approval);
    return exitForStatus(approval.status);
  }
  writeLine(ctx.io.stdout, `approvalId: ${approval.approvalId}`);
  writeLine(ctx.io.stdout, `status: ${approval.status}`);
  writeLine(ctx.io.stdout, `kind: ${approval.kind ?? (approval.actionId ? 'assistant-action' : 'run-proposal')}`);
  writeLine(ctx.io.stdout, `persona: ${approval.persona ?? ''}`);
  if (approval.workflowId) writeLine(ctx.io.stdout, `workflowId: ${approval.workflowId}`);
  if (approval.cardTitle) writeLine(ctx.io.stdout, `cardTitle: ${approval.cardTitle}`);
  if (approval.proposal) writeLine(ctx.io.stdout, `proposal: ${approval.proposal}`);
  writeLine(ctx.io.stdout, `createdAt: ${approval.createdAt ?? ''}`);
  if (approval.resolvedAt) writeLine(ctx.io.stdout, `resolvedAt: ${approval.resolvedAt}`);
  if (approval.runId) writeLine(ctx.io.stdout, `runId: ${approval.runId}`);
  if (approval.note) writeLine(ctx.io.stdout, `note: ${approval.note}`);
  if (approval.action && typeof approval.action === 'object') renderActionCard(ctx, approval.action);
  return exitForStatus(approval.status);
}

/** ADR 0862 — an assistant-action approval carries the card the host projected for the
 *  approver. Print what the action will send, and the `contentHash` a claim must echo:
 *  the hash binds the approval to THESE bytes, so it is shown beside them, never fetched
 *  and filled in behind the approver's back. */
function renderActionCard(ctx: Ctx, action: any): void {
  writeLine(ctx.io.stdout, 'action:');
  if (action.actionId) writeLine(ctx.io.stdout, `  actionId: ${action.actionId}`);
  if (action.kind) writeLine(ctx.io.stdout, `  kind: ${action.kind}`);
  if (action.riskLevel) writeLine(ctx.io.stdout, `  riskLevel: ${action.riskLevel}`);
  if (action.reason) writeLine(ctx.io.stdout, `  reason: ${action.reason}`);
  if (typeof action.draft === 'string' && action.draft.length) writeLine(ctx.io.stdout, `  draft: ${action.draft}`);
  if (action.payload && typeof action.payload === 'object') {
    for (const [k, v] of Object.entries(action.payload)) {
      writeLine(ctx.io.stdout, `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  if (action.contentHash) writeLine(ctx.io.stdout, `  contentHash: ${action.contentHash}   (claim with --content-hash ${action.contentHash})`);
}

/** The host's error `details` (`{ error, message, details }`), or `{}`. */
function detailsOf(body: unknown): { reason?: string; contentHash?: string } {
  const d = body && typeof body === 'object' ? (body as { details?: unknown }).details : undefined;
  return d && typeof d === 'object' ? (d as { reason?: string; contentHash?: string }) : {};
}

async function runApprovalsResolve(ctx: Ctx, argv: string[], verb: 'claim' | 'reject'): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--note', '--acted-for', '--expected-hash', '--content-hash'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop approvals ${verb} <approvalId> [--note <text>] [--acted-for <subject>] [--expected-hash <h>] [--content-hash <h>] [--json]\n`);
    return options.help ? 0 : 2;
  }
  await ensureApprovalsAdvertised(ctx);
  const path = `/v1/host/openwop-app/approvals/${encodeURIComponent(positionals[0])}/${verb}`;
  const decision: Record<string, string> = {};
  if (options.note !== undefined) decision.note = options.note;
  if (options.actedFor !== undefined) decision.actedFor = options.actedFor;
  if (options.expectedHash !== undefined) decision.expectedDefinitionHash = options.expectedHash;
  if (options.contentHash !== undefined) decision.expectedContentHash = options.contentHash;
  const body = Object.keys(decision).length ? decision : undefined;
  let res;
  try {
    res = await requestJson(ctx, path, { method: 'POST', ...(body !== undefined ? { body } : {}) });
  } catch (err) {
    // ADR 0862 — the assistant action changed since the approver read it. The approval
    // stays PENDING; this is not "already resolved", so it must not read like one.
    if (err instanceof HttpError && err.status === 409 && detailsOf(err.body).reason === 'action_changed') {
      const now = detailsOf(err.body).contentHash;
      throw new CliError(
        `approvals: the action behind ${positionals[0]} changed since you reviewed it — nothing was ${verb === 'claim' ? 'approved' : 'rejected'}. `
          + `Re-read it with \`openwop approvals get ${positionals[0]}\`${now ? ` (its card now hashes to ${now})` : ''} and decide on what it says now.`,
        1,
      );
    }
    // ADR 0862 — claiming an assistant action needs the hash of the card you reviewed.
    if (err instanceof HttpError && err.status === 400 && detailsOf(err.body).reason === 'content_hash_required') {
      throw new CliError(
        `approvals: ${positionals[0]} is an assistant action — read its card with \`openwop approvals get ${positionals[0]}\`, `
          + 'then pass the contentHash it shows: --content-hash <hash>.',
        2,
      );
    }
    // 409 = the host already resolved this proposal; surface its verdict legibly.
    if (err instanceof HttpError && err.status === 409) {
      const status = (err.body as { status?: string } | undefined)?.status;
      throw new CliError(`approvals: ${positionals[0]} is already ${status ?? 'resolved'} — the host rejected a second decision.`, 1);
    }
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'proposal can no longer be acted on';
      throw new CliError(`approvals: ${detail}`, 1);
    }
    gate404(err);
  }
  const out = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return exitForStatus(out.status);
  }
  if (verb === 'claim') {
    writeLine(ctx.io.stdout, `✓ Claimed approval ${out.approvalId ?? positionals[0]} → ${out.status ?? 'approved'}${out.runId ? ` (run ${out.runId})` : ''}${out.actionId ? ` (action ${out.actionId})` : ''}`);
  } else {
    writeLine(ctx.io.stdout, `✓ Rejected approval ${out.approvalId ?? positionals[0]} → ${out.status ?? 'rejected'}`);
  }
  return exitForStatus(out.status ?? (verb === 'claim' ? 'approved' : 'rejected'));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ── ADR 0478 — approval SLA policy (tenant) ──
async function runApprovalsSlaPolicy(ctx: Ctx, argv: string[]): Promise<number> {
  const setting = argv[0] === 'set';
  const { options } = parseOptions(setting ? argv.slice(1) : argv, {
    bool: ['--help', '--enabled', '--disabled'],
    value: ['--remind-after-ms', '--escalate-after-ms', '--expire-after-ms'],
  });
  if (options.help) { write(ctx.io.stdout, APPROVALS_HELP); return 0; }
  const path = '/v1/host/openwop-app/approvals/sla-policy';
  if (!setting) {
    let res;
    try { res = await requestJson(ctx, path); } catch (err) { gate404(err); }
    const p = res!.body ?? {};
    if (ctx.json) { writeJson(ctx.io.stdout, p); return 0; }
    writeLine(ctx.io.stdout, `enabled: ${p.enabled ? 'yes' : 'no'}`);
    for (const k of ['remindAfterMs', 'escalateAfterMs', 'expireAfterMs', 'updatedBy', 'updatedAt']) {
      if (p[k] !== undefined && p[k] !== null) writeLine(ctx.io.stdout, `${k}: ${p[k]}`);
    }
    return 0;
  }
  if (options.enabled && options.disabled) throw new CliError('Pass only one of --enabled / --disabled', 2);
  // The PUT replaces the policy — read the current one and merge so an unpassed timer is kept.
  let current: Record<string, any> = {};
  try { current = (await requestJson(ctx, path)).body ?? {}; } catch (err) { gate404(err); }
  const ms = (flag: string, v: unknown) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new CliError(`${flag} must be a positive integer (milliseconds).`, 2);
    return n;
  };
  const body: Record<string, unknown> = {
    enabled: options.enabled ? true : options.disabled ? false : current.enabled === true,
  };
  const timers: Array<[string, string, unknown]> = [
    ['remindAfterMs', '--remind-after-ms', options.remindAfterMs],
    ['escalateAfterMs', '--escalate-after-ms', options.escalateAfterMs],
    ['expireAfterMs', '--expire-after-ms', options.expireAfterMs],
  ];
  for (const [key, flag, value] of timers) {
    const v = ms(flag, value) ?? current[key];
    if (v !== undefined && v !== null) body[key] = v;
  }
  const res = await requestJson(ctx, path, { method: 'PUT', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Approval SLA policy ${res.body?.enabled ? 'enabled' : 'disabled'}.`);
  return 0;
}

// ── ADR 0478 §2 — your email-decide opt-in ──
async function runApprovalsEmailPref(ctx: Ctx, argv: string[]): Promise<number> {
  const setting = argv[0] === 'set';
  const { options } = parseOptions(setting ? argv.slice(1) : argv, { bool: ['--help', '--enabled', '--disabled'], value: ['--email'] });
  if (options.help) { write(ctx.io.stdout, APPROVALS_HELP); return 0; }
  const path = '/v1/host/openwop-app/approvals/email-pref';
  if (!setting) {
    let res;
    try { res = await requestJson(ctx, path); } catch (err) { gate404(err); }
    if (ctx.json) { writeJson(ctx.io.stdout, res!.body); return 0; }
    writeLine(ctx.io.stdout, `enabled: ${res!.body?.enabled ? 'yes' : 'no'}`);
    if (res!.body?.email) writeLine(ctx.io.stdout, `email: ${res!.body.email}`);
    return 0;
  }
  if (options.enabled && options.disabled) throw new CliError('Pass only one of --enabled / --disabled', 2);
  if (!options.enabled && !options.disabled) throw new CliError('email-pref set needs --enabled or --disabled.', 2);
  if (!options.email) throw new CliError('email-pref set needs --email <addr>.', 2);
  const res = await requestJson(ctx, path, { method: 'PUT', body: { email: options.email, enabled: Boolean(options.enabled) } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Email approvals ${res.body?.enabled ? 'enabled' : 'disabled'}${res.body?.email ? ` for ${res.body.email}` : ''}.`);
  return 0;
}

// ── ADR 0198 — approval delegations ──
async function runApprovalsDelegations(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(['list', 'create', 'revoke'].includes(sub) ? 1 : 0), {
    bool: ['--help', '--all'],
    value: ['--to', '--from', '--starts-at', '--ends-at', '--reason'],
  });
  if (options.help) { write(ctx.io.stdout, APPROVALS_HELP); return 0; }
  const base = '/v1/host/openwop-app/approval-delegations';
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, options.all ? `${base}?all=1` : base);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.delegations) ? res.body.delegations : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No approval delegations involve you.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((d: any) => ({
        delegationId: d.delegationId ?? d.id ?? '',
        from: d.fromSubject ?? '',
        to: d.toSubject ?? '',
        startsAt: d.startsAt ?? '',
        endsAt: d.endsAt ?? '',
        revoked: d.revokedAt ? 'yes' : 'no',
      })), ['delegationId', 'from', 'to', 'startsAt', 'endsAt', 'revoked']));
      return 0;
    }
    case 'create': {
      if (!options.to || !options.startsAt || !options.endsAt) {
        throw new CliError('delegations create needs --to <subject>, --starts-at <iso>, --ends-at <iso>.', 2);
      }
      const body: Record<string, string> = { toSubject: options.to, startsAt: options.startsAt, endsAt: options.endsAt };
      if (options.from) body.fromSubject = options.from;
      if (options.reason) body.reason = options.reason;
      const res = await requestJson(ctx, base, { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const d = res.body?.delegation ?? {};
      writeLine(ctx.io.stdout, `Created delegation ${d.delegationId ?? d.id ?? ''}: ${d.fromSubject ?? 'you'} → ${d.toSubject ?? options.to} (${d.startsAt ?? options.startsAt} – ${d.endsAt ?? options.endsAt}).`);
      return 0;
    }
    case 'revoke': {
      if (positionals.length !== 1) throw new CliError('Usage: openwop approvals delegations revoke <delegationId> [--json]', 2);
      const res = await requestJson(ctx, `${base}/${encodeURIComponent(positionals[0])}/revoke`, { method: 'POST' });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Revoked delegation ${positionals[0]}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown approvals delegations command: ${sub}`);
  }
}
