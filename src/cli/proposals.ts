import type { Ctx } from '../context.js';
/** `openwop proposals ...` — the reviewable-learning proposal lifecycle (RFC 0096).
 *
 * An agent's learned change lands as an INERT proposal — a stored artifact draft
 * that does nothing until a human reviews it and applies it through the host's
 * activation gate. This group drives the host's proposal surface (sample
 * host-extension, non-normative; promotable to the normative /v1/proposals path
 * at graduation):
 *   GET    /v1/host/sample/proposals[?state=&kind=]   — the review queue
 *   GET    /v1/host/sample/proposals/{id}             — one proposal
 *   PATCH  /v1/host/sample/proposals/{id}             — revise the draft (never activates)
 *   POST   /v1/host/sample/proposals/{id}/apply       — materialize the stored draft via the host's activation mode
 *   POST   /v1/host/sample/proposals/{id}/reject      — decline
 *   DELETE /v1/host/sample/proposals/{id}             — archive (soft-delete)
 *
 * Capability honesty is the whole point: the HOST is the authority. `apply` does
 * NOT activate anything locally — it asks the host to install the byte image last
 * persisted on the proposal (no re-synthesis, RFC 0096 `proposal-no-resynthesis`)
 * and to route activation through its advertised `agents.proposals.activation`
 * mode (e.g. an RFC 0051 approval-gate). The CLI renders the host's resolved view
 * and relays the verb; it never decides. Gated on `capabilities.agents.proposals`
 * (advertised in /.well-known/openwop); fails closed when absent.
 *
 * Boundary vs `approvals`: approvals are the human action-queue (claim/reject a
 * queued run); proposals are the stored *artifact drafts* an agent learned and a
 * human reviews before they ever become live behavior.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const PROPOSALS_HELP = `Usage:
  openwop proposals list [--state <s>] [--kind <k>] [--json]
  openwop proposals get <proposalId> [--json]
  openwop proposals revise <proposalId> [--artifact-json '{...}'] [--note <text>] [--json]
  openwop proposals apply <proposalId> [--json]
  openwop proposals reject <proposalId> [--note <text>] [--json]
  openwop proposals archive <proposalId> [--yes]

Reviewable-learning proposals (RFC 0096). An agent's learned change is stored as
an INERT proposal — it does nothing until a human applies it. 'list'/'get' render
the host's review queue. 'revise' edits the stored draft WITHOUT activating it.
'apply' asks the host to materialize the byte image last persisted on the
proposal (no re-synthesis) and route activation through the host's advertised
mode (e.g. an approval-gate) — the CLI never activates locally. 'reject' declines;
'archive' soft-deletes.

The host is the authority for every decision — the CLI renders the host's
resolved view and relays your verb; it never decides. If the host does not
advertise the proposal surface (/.well-known/openwop), the group fails closed
rather than guessing.

Endpoints:
  list     GET    /v1/host/sample/proposals[?state=&kind=]
  get      GET    /v1/host/sample/proposals/{id}
  revise   PATCH  /v1/host/sample/proposals/{id}      (revise; never activates)
  apply    POST   /v1/host/sample/proposals/{id}/apply
  reject   POST   /v1/host/sample/proposals/{id}/reject
  archive  DELETE /v1/host/sample/proposals/{id}      (soft)

  --state <s>          (list) Filter by lifecycle state (e.g. pending, applied, rejected, archived).
  --kind <k>           (list) Filter by artifact kind (RFC 0096 artifactKinds).
  --artifact-json J    (revise) The revised draft artifact (validated host-side).
  --note <text>        (revise/reject) Optional human note recorded with the action.
  --yes                (archive) Required to confirm the soft-delete.
  --json               Print the raw host response instead of the rendered view.

Boundary: this is NOT \`approvals\`. Approvals are the human action-queue
(claim/reject a queued run); proposals are the stored artifact drafts a human
reviews before they ever become live behavior.

Exit codes (get/apply/reject reflect the proposal's resulting state, so scripts
can gate on the verdict):
  0  applied         3  pending (in review)        1  rejected/archived or error
\`list\` exits 0 on success.

Examples:
  openwop proposals list --state pending
  openwop proposals get prop_123 --json
  openwop proposals revise prop_123 --artifact-json '{"systemPrompt":"..."}'
  openwop proposals apply prop_123
  openwop proposals reject prop_123 --note "out of scope"
  openwop proposals archive prop_123 --yes
`;

const SUBCOMMANDS = ['list', 'get', 'revise', 'apply', 'reject', 'archive'];

export async function runProposals(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, PROPOSALS_HELP);
    return 0;
  }
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list':
      return await runProposalsList(ctx, args);
    case 'get':
      return await runProposalsGet(ctx, args);
    case 'revise':
      return await runProposalsRevise(ctx, args);
    case 'apply':
      return await runProposalsApply(ctx, args);
    case 'reject':
      return await runProposalsReject(ctx, args);
    case 'archive':
      return await runProposalsArchive(ctx, args);
    default:
      throw new CliError(`Unknown proposals command: ${sub}\nRun \`openwop proposals --help\` for usage.`);
  }
}

/** 0 applied · 3 pending (in review) · 1 rejected/archived/unknown. A proposal's
 *  state is the host's verdict; the CLI mirrors it so `get`/`apply`/`reject`
 *  report the same exit. */
function exitForState(state: unknown): number {
  if (state === 'applied' || state === 'active' || state === 'installed') return 0;
  if (state === 'pending' || state === 'pending-review' || state === 'in-review' || state === 'draft' || state === 'revised') return 3;
  return 1; // rejected / archived / anything unexpected
}

/** Capability honesty: confirm the host advertises `agents.proposals` (RFC 0096 /
 *  host-sample-test-seams.md §11) before we drive it. A reachable discovery doc
 *  that omits the flag ⇒ fail closed. An unreachable/absent discovery doc is
 *  inconclusive (not a denial) — defer to the live call's 404 translation rather
 *  than blocking a host that simply doesn't serve /.well-known/openwop. */
async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return; // can't prove absence — let the real request decide
  const body = wk.body && typeof wk.body === 'object' ? (wk.body as any) : {};
  const advertised = !!(body.capabilities?.agents?.proposals ?? body.agents?.proposals);
  if (!advertised) {
    throw new CliError(
      'proposals: this host does not advertise the reviewable-learning proposal capability (capabilities.agents.proposals is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
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
      `proposals: ${detail} (the host must mount /v1/host/sample/proposals; the CLI renders the host's queue, it never decides).`,
      1,
    );
  }
  throw err;
}

async function fetchOne(ctx: Ctx, id: string): Promise<any> {
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/proposals/${encodeURIComponent(id)}`);
  } catch (err) {
    gate404(err);
  }
  return res!.body ?? {};
}

async function runProposalsList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--state', '--kind'] });
  if (options.help) {
    write(ctx.io.stdout, PROPOSALS_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  const query: string[] = [];
  if (options.state !== undefined) query.push(`state=${encodeURIComponent(options.state)}`);
  if (options.kind !== undefined) query.push(`kind=${encodeURIComponent(options.kind)}`);
  const path = `/v1/host/sample/proposals${query.length ? `?${query.join('&')}` : ''}`;
  let res;
  try {
    res = await requestJson(ctx, path);
  } catch (err) {
    gate404(err);
  }
  const proposals = Array.isArray(res!.body?.proposals) ? res!.body.proposals : [];
  if (ctx.json) {
    writeJson(ctx.io.stdout, { proposals });
    return 0;
  }
  if (proposals.length === 0) {
    writeLine(ctx.io.stdout, `No proposals${options.state ? ` in state ${options.state}` : ''}${options.kind ? ` of kind ${options.kind}` : ''} on this host.`);
    return 0;
  }
  const rows = proposals.map((p: any) => ({
    proposalId: p.proposalId ?? p.id,
    state: p.state ?? '',
    kind: p.kind ?? p.artifactKind ?? '',
    activation: p.activation ?? '',
    persona: p.persona ?? p.agentId ?? '',
    title: truncate(p.title ?? p.summary ?? '', 40),
    createdAt: p.createdAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['proposalId', 'state', 'kind', 'activation', 'persona', 'title', 'createdAt']));
  return 0;
}

async function runProposalsGet(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop proposals get <proposalId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  const p = await fetchOne(ctx, positionals[0]);
  if (ctx.json) {
    writeJson(ctx.io.stdout, p);
    return exitForState(p.state);
  }
  renderProposal(ctx, p, positionals[0]);
  return exitForState(p.state);
}

function renderProposal(ctx: Ctx, p: any, fallbackId: string): void {
  writeLine(ctx.io.stdout, `proposalId: ${p.proposalId ?? p.id ?? fallbackId}`);
  writeLine(ctx.io.stdout, `state: ${p.state ?? ''}`);
  writeLine(ctx.io.stdout, `kind: ${p.kind ?? p.artifactKind ?? ''}`);
  if (p.activation) writeLine(ctx.io.stdout, `activation: ${p.activation}`);
  if (p.persona ?? p.agentId) writeLine(ctx.io.stdout, `persona: ${p.persona ?? p.agentId}`);
  if (p.title) writeLine(ctx.io.stdout, `title: ${p.title}`);
  if (p.summary) writeLine(ctx.io.stdout, `summary: ${p.summary}`);
  if (p.rationale) writeLine(ctx.io.stdout, `rationale: ${p.rationale}`);
  if (p.installedArtifactRef) writeLine(ctx.io.stdout, `installedArtifactRef: ${p.installedArtifactRef}`);
  writeLine(ctx.io.stdout, `createdAt: ${p.createdAt ?? ''}`);
  if (p.revisedAt) writeLine(ctx.io.stdout, `revisedAt: ${p.revisedAt}`);
  if (p.resolvedAt) writeLine(ctx.io.stdout, `resolvedAt: ${p.resolvedAt}`);
  if (p.note) writeLine(ctx.io.stdout, `note: ${p.note}`);
}

// PATCH — revise the stored draft. Per RFC 0096 this MUST NOT activate; the CLI
// only sends the revised fields and renders the host's resolved proposal.
async function runProposalsRevise(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--artifact-json', '--note'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, "Usage: openwop proposals revise <proposalId> [--artifact-json '{...}'] [--note <text>] [--json]\n");
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = {};
  if (options.artifactJson !== undefined) {
    try {
      body.artifact = JSON.parse(options.artifactJson);
    } catch {
      throw new CliError('--artifact-json must be valid JSON', 2);
    }
  }
  if (options.note !== undefined) body.note = options.note;
  if (Object.keys(body).length === 0) throw new CliError('Nothing to revise — pass --artifact-json and/or --note.', 2);
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/proposals/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'revision rejected (malformed for kind)';
      throw new CliError(`proposals: ${detail}`, 1);
    }
    gate404(err);
  }
  const p = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, p);
    return exitForState(p.state);
  }
  writeLine(ctx.io.stdout, `✓ Revised proposal ${p.proposalId ?? p.id ?? positionals[0]} (state ${p.state ?? 'unchanged'}; not activated).`);
  return exitForState(p.state);
}

// POST /apply — ask the host to materialize the stored draft via its activation
// mode. The CLI never activates locally; it relays the verb and renders the
// host's outcome (which may be a pending approval-gate, RFC 0051).
async function runProposalsApply(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop proposals apply <proposalId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/proposals/${encodeURIComponent(positionals[0])}/apply`, { method: 'POST' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      throw new CliError(`proposals: the host refused to apply ${positionals[0]} — you lack the scope to activate this proposal (the host is the authority).`, 1);
    }
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'proposal is malformed for its kind';
      throw new CliError(`proposals: ${detail}`, 1);
    }
    gate404(err);
  }
  const out = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return out.state ? exitForState(out.state) : 0;
  }
  if (out.installedArtifactRef) {
    writeLine(ctx.io.stdout, `✓ Applied proposal ${positionals[0]} → installed ${out.installedArtifactRef}.`);
  } else if (out.state === 'pending' || out.activation === 'approval-gate') {
    writeLine(ctx.io.stdout, `Proposal ${positionals[0]} routed to the host's activation gate (state ${out.state ?? 'pending'}); awaiting approval.`);
  } else {
    writeLine(ctx.io.stdout, `✓ Applied proposal ${positionals[0]}${out.state ? ` → ${out.state}` : ''}.`);
  }
  return out.state ? exitForState(out.state) : 0;
}

async function runProposalsReject(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--note'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop proposals reject <proposalId> [--note <text>] [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  const body = options.note !== undefined ? { note: options.note } : undefined;
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/proposals/${encodeURIComponent(positionals[0])}/reject`, { method: 'POST', ...(body !== undefined ? { body } : {}) });
  } catch (err) {
    gate404(err);
  }
  const p = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, p);
    return exitForState(p.state ?? 'rejected');
  }
  writeLine(ctx.io.stdout, `✓ Rejected proposal ${p.proposalId ?? p.id ?? positionals[0]} → ${p.state ?? 'rejected'}.`);
  return exitForState(p.state ?? 'rejected');
}

// DELETE — archive (soft-delete). A deliberate dismissal; reports a non-zero
// (rejected/archived) verdict per the lifecycle exit contract, with a success line.
async function runProposalsArchive(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop proposals archive <proposalId> [--yes]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) {
    writeLine(ctx.io.stderr, `Refusing to archive proposal ${positionals[0]} without --yes.`);
    return 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/proposals/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  } catch (err) {
    gate404(err);
  }
  const p = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, p);
    return exitForState(p.state ?? 'archived');
  }
  writeLine(ctx.io.stdout, `✓ Archived proposal ${p.proposalId ?? p.id ?? positionals[0]} → ${p.state ?? 'archived'}.`);
  return exitForState(p.state ?? 'archived');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
