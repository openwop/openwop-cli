import type { Ctx } from '../context.js';
/** `openwop triggers ...` — external-event trigger subscriptions (RFC 0099).
 *
 * The trigger bridge lets an externally-originated event (webhook / email / form)
 * deliver into a durable subscription that starts a run. This group drives the
 * NORMATIVE subscription surface:
 *   POST /v1/trigger-subscriptions       — register a subscription (source → workflow)
 *   GET  /v1/trigger-subscriptions       — list subscriptions
 *   GET  /v1/trigger-subscriptions/{id}  — one subscription (falls back to a list filter)
 *
 * Capability honesty: gated on `capabilities.triggerBridge` (and, for register,
 * `triggerBridge.ingestion.externalSources` honesty gate — a source the host
 * doesn't externally-ingest is refused before the call). The host is the
 * authority; the CLI renders its resolved subscription + relays the registration.
 *
 * Secret boundary (RFC 0099 §F.2 / SR-1): a webhook subscription's binding
 * secret is returned EXACTLY ONCE at creation — the CLI surfaces it with a
 * one-time warning (the deliberate exception, like SP metadata XML) and never
 * persists it; re-reading a subscription returns only the `secretFingerprint`.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const TRIGGERS_HELP = `Usage:
  openwop triggers register --source <webhook|email|form> --workflow <id> [--dedup] [--verification <mode>] [--json]
  openwop triggers list [--state <s>] [--source <s>] [--json]
  openwop triggers get <subscriptionId> [--json]

External-event trigger subscriptions (RFC 0099). A subscription binds an external
SOURCE (webhook / email / form) to a WORKFLOW the caller can start; a verified
inbound event then starts a run with the event as \`ctx.triggerData\`. 'register'
creates the subscription and returns its source-specific binding (the ingest URL /
address); 'list'/'get' render the host's subscription state machine
(active | paused | failed | dead-lettered).

The host is the authority — it verifies the source, dedups, and runs the durable
delivery state machine; the CLI renders its resolved view and relays the
registration. Gated on \`capabilities.triggerBridge\`; fails closed when the host
doesn't advertise the bridge (or, for register, the requested source under
\`triggerBridge.ingestion.externalSources\`).

Endpoints:
  register  POST /v1/trigger-subscriptions
  list      GET  /v1/trigger-subscriptions
  get       GET  /v1/trigger-subscriptions/{id}  (falls back to filtering the list)

  --source <s>          (register/list) webhook | email | form.
  --workflow <id>       (register) The workflow the subscription starts (must be one you can start).
  --dedup               (register) Enable effectively-once dedup on the subscription.
  --verification <mode> (register) The host's verification policy (e.g. none | optional | required).
  --state <s>           (list) Filter by subscription state.
  --json                Print the raw host response instead of the rendered view.

Secret boundary: a webhook binding secret is returned ONCE at creation — store it
then; the CLI never persists it and re-reads show only the secret fingerprint.

Exit codes (get reflects the subscription's state, so scripts can gate):
  0  active        3  paused        1  failed / dead-lettered or error
\`list\` exits 0 on success.

Examples:
  openwop triggers register --source webhook --workflow wf_intake --dedup --verification required
  openwop triggers list --state active
  openwop triggers get sub_123 --json
`;

const SUBCOMMANDS = ['register', 'list', 'get'];

export async function runTriggers(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, TRIGGERS_HELP);
    return 0;
  }
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'register':
      return await runRegister(ctx, args);
    case 'list':
      return await runList(ctx, args);
    case 'get':
      return await runGet(ctx, args);
    default:
      throw new CliError(`Unknown triggers command: ${sub}\nRun \`openwop triggers --help\` for usage.`);
  }
}

/** 0 active · 3 paused · 1 failed / dead-lettered / unknown — the subscription's
 *  state is the host's; the CLI mirrors it. */
function exitForState(state: unknown): number {
  if (state === 'active') return 0;
  if (state === 'paused') return 3;
  return 1; // failed / dead-lettered / anything unexpected
}

/** Read the discovery doc's capability block (capabilities.triggerBridge), per
 *  trigger-bridge.md §F.3 — advertised via capabilities.*, not a paths map. */
async function triggerBridgeCaps(ctx: Ctx): Promise<any | undefined> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return undefined; // inconclusive — let the live call decide
  const body = wk.body && typeof wk.body === 'object' ? (wk.body as any) : {};
  return body.capabilities?.triggerBridge ?? body.triggerBridge ?? null;
}

async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const tb = await triggerBridgeCaps(ctx);
  if (tb === undefined) return; // discovery unreachable — defer to the live 404
  if (!tb) {
    throw new CliError(
      'triggers: this host does not advertise the trigger bridge (capabilities.triggerBridge is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
      1,
    );
  }
}

function gate404(err: unknown): never {
  if (err instanceof HttpError && err.status === 404) {
    const detail =
      err.body && typeof err.body === 'object' && typeof (err.body as { message?: string }).message === 'string'
        ? (err.body as { message?: string }).message
        : 'not found';
    throw new CliError(
      `triggers: ${detail} (the host must serve /v1/trigger-subscriptions; the CLI renders the host's subscriptions, it never fabricates one).`,
      1,
    );
  }
  throw err;
}

async function runRegister(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, {
    bool: ['--help', '--dedup'],
    value: ['--source', '--workflow', '--verification'],
  });
  if (options.help || !options.source || !options.workflow) {
    write(ctx.io.stdout, 'Usage: openwop triggers register --source <webhook|email|form> --workflow <id> [--dedup] [--verification <mode>] [--json]\n');
    return options.help ? 0 : 2;
  }
  if (!['webhook', 'email', 'form'].includes(options.source)) {
    throw new CliError('--source must be one of: webhook, email, form', 2);
  }
  // Honesty gate: refuse a source the host doesn't externally-ingest (§F.3).
  const tb = await triggerBridgeCaps(ctx);
  if (tb) {
    const ext = tb.ingestion?.externalSources;
    if (Array.isArray(ext) && !ext.includes(options.source)) {
      throw new CliError(
        `triggers: this host does not externally-ingest the '${options.source}' source (capabilities.triggerBridge.ingestion.externalSources = ${JSON.stringify(ext)}).`,
        1,
      );
    }
    if (tb.ingestion === undefined && tb.supported) {
      throw new CliError(
        'triggers: this host advertises triggerBridge but not external ingestion (capabilities.triggerBridge.ingestion is absent) — it cannot register an external-event subscription.',
        1,
      );
    }
  } else if (tb === null) {
    throw new CliError('triggers: this host does not advertise the trigger bridge. The host is the authority — refusing to guess.', 1);
  }
  const body: Record<string, any> = { source: options.source, workflowId: options.workflow };
  if (options.dedup) body.dedupEnabled = true;
  if (options.verification !== undefined) body.verification = { mode: options.verification };
  let res;
  try {
    res = await requestJson(ctx, '/v1/trigger-subscriptions', { method: 'POST', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      throw new CliError(`triggers: the host refused the registration (403) — you cannot bind workflow ${options.workflow} (you must be able to start it; the host is the authority).`, 1);
    }
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'registration rejected';
      throw new CliError(`triggers: ${detail}`, 1);
    }
    gate404(err);
  }
  const out = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return exitForState(out.subscription?.state ?? out.state);
  }
  const s = out.subscription ?? out;
  writeLine(ctx.io.stdout, `✓ Registered ${s.source ?? options.source} subscription ${s.subscriptionId ?? s.id ?? ''} (state ${s.state ?? 'active'}).`);
  const binding = out.binding ?? s.binding;
  if (binding) {
    if (binding.ingestUrl) writeLine(ctx.io.stdout, `ingestUrl: ${binding.ingestUrl}`);
    if (binding.ingestAddress) writeLine(ctx.io.stdout, `ingestAddress: ${binding.ingestAddress}`);
    if (binding.secretFingerprint) writeLine(ctx.io.stdout, `secretFingerprint: ${binding.secretFingerprint}`);
    if (binding.secret) {
      writeLine(ctx.io.stdout, `secret: ${binding.secret}`);
      writeLine(ctx.io.stderr, '⚠ This binding secret is shown ONCE and is not stored by the CLI — copy it now. Re-reading the subscription returns only the fingerprint.');
    }
  }
  return exitForState(s.state);
}

async function fetchList(ctx: Ctx, query: string[]): Promise<any[]> {
  const path = `/v1/trigger-subscriptions${query.length ? `?${query.join('&')}` : ''}`;
  let res;
  try {
    res = await requestJson(ctx, path);
  } catch (err) {
    gate404(err);
  }
  const b = res!.body;
  return Array.isArray(b?.subscriptions) ? b.subscriptions : (Array.isArray(b?.items) ? b.items : (Array.isArray(b) ? b : []));
}

async function runList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--state', '--source'] });
  if (options.help) {
    write(ctx.io.stdout, TRIGGERS_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  const query: string[] = [];
  if (options.state !== undefined) query.push(`state=${encodeURIComponent(options.state)}`);
  if (options.source !== undefined) query.push(`source=${encodeURIComponent(options.source)}`);
  const subs = await fetchList(ctx, query);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { subscriptions: subs });
    return 0;
  }
  if (subs.length === 0) {
    writeLine(ctx.io.stdout, `No trigger subscriptions${options.state ? ` in state ${options.state}` : ''}${options.source ? ` for source ${options.source}` : ''} on this host.`);
    return 0;
  }
  const rows = subs.map((s: any) => ({
    subscriptionId: s.subscriptionId ?? s.id,
    source: s.source ?? '',
    state: s.state ?? '',
    workflow: s.workflowId ?? '',
    dedup: s.dedupEnabled ? 'yes' : 'no',
    createdAt: s.createdAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['subscriptionId', 'source', 'state', 'workflow', 'dedup', 'createdAt']));
  return 0;
}

async function runGet(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop triggers get <subscriptionId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  const id = positionals[0];
  let s: any;
  try {
    const res = await requestJson(ctx, `/v1/trigger-subscriptions/${encodeURIComponent(id)}`);
    s = res.body ?? {};
  } catch (err) {
    // The single-subscription GET may not be mounted yet (the read surface lands
    // at Active→Accepted) — fall back to filtering the list.
    if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
      const found = (await fetchList(ctx, [])).find((x: any) => (x.subscriptionId ?? x.id) === id);
      if (!found) throw new CliError(`triggers: no subscription found with id ${id}.`, 1);
      s = found;
    } else {
      gate404(err);
    }
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, s);
    return exitForState(s.state);
  }
  writeLine(ctx.io.stdout, `subscriptionId: ${s.subscriptionId ?? s.id ?? id}`);
  writeLine(ctx.io.stdout, `source: ${s.source ?? ''}`);
  writeLine(ctx.io.stdout, `state: ${s.state ?? ''}`);
  if (s.workflowId) writeLine(ctx.io.stdout, `workflowId: ${s.workflowId}`);
  writeLine(ctx.io.stdout, `dedupEnabled: ${s.dedupEnabled ? 'yes' : 'no'}`);
  if (s.secretFingerprint) writeLine(ctx.io.stdout, `secretFingerprint: ${s.secretFingerprint}`);
  if (s.retryPolicy) writeLine(ctx.io.stdout, `retryPolicy: ${JSON.stringify(s.retryPolicy)}`);
  if (s.lastDelivery) writeLine(ctx.io.stdout, `lastDelivery: ${JSON.stringify(s.lastDelivery)}`);
  writeLine(ctx.io.stdout, `createdAt: ${s.createdAt ?? ''}`);
  return exitForState(s.state);
}
