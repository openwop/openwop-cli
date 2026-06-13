import type { Ctx } from '../context.js';
/** `openwop approvals ...` — the human side of "agents propose, humans dispose".
 *
 * Drives the host's approval inbox (sample host-extension, non-normative):
 *   GET  /v1/host/sample/approvals[?status=pending|approved|rejected]
 *   POST /v1/host/sample/approvals/{id}/claim   — affirmative sign-off (starts the run)
 *   POST /v1/host/sample/approvals/{id}/reject  — dismiss the proposal
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
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const APPROVALS_HELP = `Usage:
  openwop approvals list [--status pending|approved|rejected] [--json]
  openwop approvals get <approvalId> [--json]
  openwop approvals claim <approvalId> [--note <text>] [--json]
  openwop approvals reject <approvalId> [--note <text>] [--json]

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
  list    GET  /v1/host/sample/approvals[?status=...]
  get     GET  /v1/host/sample/approvals   (filtered to <approvalId> client-side;
          the host exposes no single-approval GET)
  claim   POST /v1/host/sample/approvals/{id}/claim
  reject  POST /v1/host/sample/approvals/{id}/reject

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
  openwop approvals reject appr_123 --note "out of policy"
`;

const SUBCOMMANDS = ['list', 'get', 'claim', 'reject', 'approve', 'deny'];

export async function runApprovals(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, APPROVALS_HELP);
    return 0;
  }
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
  const paths = wk.body && typeof wk.body === 'object' ? (wk.body as { paths?: unknown }).paths : undefined;
  const advertised =
    paths !== null && typeof paths === 'object' &&
    Object.keys(paths as Record<string, unknown>).some((p) => p.startsWith('/v1/host/sample/approvals'));
  if (!advertised) {
    throw new CliError(
      'approvals: this host does not advertise the approval-inbox surface (/v1/host/sample/approvals is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
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
      `approvals: ${detail} (the host must mount /v1/host/sample/approvals; the CLI renders the host's queue, it never decides).`,
      1,
    );
  }
  throw err;
}

async function fetchQueue(ctx: Ctx, status?: string): Promise<any[]> {
  const path = status ? `/v1/host/sample/approvals?status=${encodeURIComponent(status)}` : '/v1/host/sample/approvals';
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
  return exitForStatus(approval.status);
}

async function runApprovalsResolve(ctx: Ctx, argv: string[], verb: 'claim' | 'reject'): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--note'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop approvals ${verb} <approvalId> [--note <text>] [--json]\n`);
    return options.help ? 0 : 2;
  }
  await ensureApprovalsAdvertised(ctx);
  const path = `/v1/host/sample/approvals/${encodeURIComponent(positionals[0])}/${verb}`;
  const body = options.note !== undefined ? { note: options.note } : undefined;
  let res;
  try {
    res = await requestJson(ctx, path, { method: 'POST', ...(body !== undefined ? { body } : {}) });
  } catch (err) {
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
