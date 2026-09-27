import type { Ctx } from '../context.js';
/** `openwop runs ...` — create/list/inspect/annotate/debug runs. */
import { writeFileSync } from 'node:fs';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { sleep } from '../util.js';
import { TERMINAL_STATUSES } from '../constants.js';
import { buildInputs } from './shared.js';
import { pollCursorParam, pollIsTerminal, streamRunEvents, renderEvent, parseStreamStart } from '../sse.js';
import { canonicalEventType, isTerminalRunEvent } from '../eventTypes.js';
import { idempotencyHeaders, isIdempotentReplay } from '../wire.js';
import { hostRunSegment } from './requestHelpers.js';

export const RUNS_HELP = `Usage:
  openwop runs list [--status status] [--workflow-id id] [--limit n] [--cursor c] [--tenant-id id] [--json]
  openwop runs create <workflowId> [--input k=v] [--inputs-json JSON] [--tenant-id id] [--idempotency-key k] [--wait] [--json]
  openwop runs get <runId> [--json]
  openwop runs cancel <runId> [--reason text] [--json]
  openwop runs ancestry <runId> [--json]
  openwop runs events <runId> [--since <sequence>] [--limit n] [--json]
  openwop runs events <runId> --follow [--since <sequence> | --last-event-id <id>] [--stream-mode mode] [--no-stream] [--json]
  openwop runs watch <runId> [same flags as events --follow]
  openwop runs annotations <runId> [--json]
  openwop runs annotate <runId> (--rating 1-5 | --label t | --correction t | --flag) [--note t] [--event-id id] [--node-id id]
  openwop runs debug-bundle <runId> [--max-events n] [--out file] [--json]
  openwop runs fork <runId> [--mode replay|branch] [--from-sequence n] [--idempotency-key k] [--json]
  openwop runs diff <runId> --against <otherRunId> [--json]
  openwop runs delete <runId> [--yes]
  openwop runs bulk-cancel <runId...> [--reason text] [--json]
  openwop runs effects <runId> [--json]
  openwop runs revision <runId> [--json]
  openwop runs pin <runId> [--json]
  openwop runs unpin <runId> [--json]
  openwop runs redrive <runId...> [--json]

\`runs effects\` reads the run's side-effect ledger (GET /v1/runs/{runId}/effects;
idempotency.md §Layer 2): one row per effect attempt, with a stable effectId,
nodeId, attempt, state (claimed | completed) and time.

Host-extension run tools (non-normative, /v1/host/openwop-app/…):
  revision  GET  …/runs/{runId}/revision — which workflow revision the run pinned,
            whether the head has moved since, and its launch/debug/redrive provenance.
  pin/unpin POST …/runs/{runId}/pin { pinned } — keep a run from retention cleanup.
  redrive   POST …/runs/redrive { runIds } — re-run failed runs (1–25 ids) on their
            pinned revision; each id reports a new redriveRunId or an error code.
            Exits 1 when any id failed to redrive.

\`runs events\` polls GET /v1/runs/{runId}/events/poll (JSON, not SSE); --since N
returns events with sequence > N (sent as \`afterSequence\` to a v2 host,
\`lastSequence\` to a v1 host).

\`runs events --follow\` (alias \`runs watch\`) streams GET /v1/runs/{runId}/events
as SSE until the run's terminal event, falling back to the poll endpoint when
the host does not serve SSE (--no-stream forces the poll). A dropped stream is
resumed automatically with the \`Last-Event-ID\` header (bounded retries,
honouring the server's \`retry:\` field), and no event is printed twice.
  --since N           start after sequence N — sent as \`Last-Event-ID: N\` on
                      SSE (both majors: the header is the only SSE cursor;
                      \`since\` is not a query parameter) and as the poll cursor
                      on the fallback.
  --last-event-id ID  start after this SSE id, sent verbatim. Under v2 an id is
                      a sequence, so it must be a non-negative integer.
  --stream-mode M     \`?streamMode=\`: updates (default) | values | messages |
                      debug, or a comma list of updates/messages/debug
                      (\`values\` never combines). A host that does not serve
                      the mode answers 400 unsupported_stream_mode.
  --idle-timeout-ms N a connection that delivers no bytes for N ms (default
                      45000; 0 disables) is treated as dropped and resumed. A
                      stream whose headers do not arrive within 10 s is given
                      up on and followed by polling, with a hint on stderr.
Streams are read from the stream origin: --stream-base-url (global), else the
host's advertised \`streamBase\` (https only), else --base-url — some front
doors buffer event streams entirely (e.g. a CDN rewrite).
Exit 0 when the run completes, 1 when it fails or is cancelled. \`runs list\` pages with --cursor: pass the
\`nextCursor\` the previous page printed.

Run ids: under protocol v2 a run id is tenant-bound (\`<tenantId>/<id>\`); pass it
as printed — the CLI sends it in the projected wire form (\`~2F\`). \`runs create\`
and \`runs fork\` send an Idempotency-Key (a fresh UUID unless
--idempotency-key is given, so re-running the same command after a timeout
cannot start a second run). \`runs annotate\` posts a review signal
(rating/label/correction/flag) and \`runs annotations\` lists them. \`runs
debug-bundle\` exports a run's full event bundle — pass --out to save it to a file.

The \`runs ancestry\` command walks the RFC 0040 cross-host parent chain from the
requested run up to its top-level root (each run has one parent, so the ancestry
is linear). The endpoint is opt-in: the host must advertise
\`crossHostCausation.ancestryEndpointSupported\` or the command reports it as
unavailable.

Input parsing for \`runs create\`:
  --input k=v       Each value is JSON.parse'd first; on parse failure it falls back to a string.
                    So \`--input n=5\` yields the number 5, \`--input enabled=true\` yields the
                    boolean true, \`--input text=hello\` yields the string "hello", and
                    \`--input list=[1,2,3]\` yields an array. Quote shell-special characters.
  --inputs-json J   Pass the whole \`inputs\` object as one JSON literal. Merged BEFORE
                    --input k=v pairs (which override).
  --wait            Poll GET /v1/runs/{runId} every 250ms until terminal status or
                    --timeout-ms (default 30000) elapses. Exit 0 only on \`completed\`.
`;

export async function runRuns(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'create', 'get', 'cancel', 'ancestry', 'events', 'watch', 'annotations', 'annotate', 'debug-bundle', 'fork', 'diff', 'delete', 'bulk-cancel', 'effects', 'revision', 'pin', 'unpin', 'redrive'].includes(sub) ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, RUNS_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return runRunsList(ctx, args);
    case 'create':
      return runRunsCreate(ctx, args);
    case 'get':
      return runRunsGet(ctx, args);
    case 'cancel':
      return runRunsCancel(ctx, args);
    case 'ancestry':
      return runRunsAncestry(ctx, args);
    case 'events':
      return runRunsEvents(ctx, args);
    case 'watch':
      return runRunsEvents(ctx, ['--follow', ...args]);
    case 'annotations':
      return runRunsAnnotations(ctx, args);
    case 'annotate':
      return runRunsAnnotate(ctx, args);
    case 'debug-bundle':
      return runRunsDebugBundle(ctx, args);
    case 'fork':
      return runRunsFork(ctx, args);
    case 'diff':
      return runRunsDiff(ctx, args);
    case 'delete':
      return runRunsDelete(ctx, args);
    case 'bulk-cancel':
      return runRunsBulkCancel(ctx, args);
    case 'effects':
      return runRunsEffects(ctx, args);
    case 'revision':
      return runRunsRevision(ctx, args);
    case 'pin':
    case 'unpin':
      return runRunsPin(ctx, args, sub === 'pin');
    case 'redrive':
      return runRunsRedrive(ctx, args);
    default:
      throw new CliError(`Unknown runs command: ${sub}`);
  }
}

async function runRunsList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--status', '--limit', '--tenant-id', '--cursor', '--workflow-id'],
  });
  if (options.help) {
    write(ctx.io.stdout, RUNS_HELP);
    return 0;
  }
  const query = new URLSearchParams();
  if (options.status) query.set('status', options.status);
  if (options.limit) query.set('limit', options.limit);
  if (options.tenantId) query.set('tenantId', options.tenantId);
  if (options.workflowId) query.set('workflowId', options.workflowId);
  if (options.cursor) query.set('cursor', options.cursor);
  const path = `/v1/runs${query.size ? `?${query.toString()}` : ''}`;
  const res = await requestJson(ctx, path);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const rows = (res.body.runs ?? []).map((r: any) => ({
    runId: r.runId,
    workflowId: r.workflowId,
    status: r.status,
    createdAt: r.createdAt ?? r.startedAt ?? '',
  }));
  writeLine(ctx.io.stdout, rows.length ? formatTable(rows, ['runId', 'workflowId', 'status', 'createdAt']) : 'No runs found.');
  // v2 listRuns pages with an opaque cursor (runs.md §List).
  if (typeof res.body?.nextCursor === 'string' && res.body.nextCursor.length > 0) {
    writeLine(ctx.io.stdout, `More runs: openwop runs list --cursor ${res.body.nextCursor}`);
  }
  return 0;
}

async function runRunsCreate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--wait'],
    value: ['--tenant-id', '--scope-id', '--inputs-json', '--timeout-ms', '--idempotency-key'],
    multi: ['--input'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs create <workflowId> [--input k=v] [--inputs-json JSON] [--tenant-id id] [--wait] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body = {
    workflowId: positionals[0],
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.scopeId ? { scopeId: options.scopeId } : {}),
    inputs: buildInputs(options),
  };
  const res = await requestJson(ctx, '/v1/runs', { method: 'POST', body, headers: idempotencyHeaders(options.idempotencyKey) });
  const replayed = isIdempotentReplay(res.headers) ? ' — replayed from the idempotency cache, no new run started' : '';
  if (options.wait) {
    const snap = await waitForRun(ctx, res.body.runId, Number(options.timeoutMs ?? 30000));
    if (ctx.json) writeJson(ctx.io.stdout, { created: res.body, final: snap });
    else {
      writeLine(ctx.io.stdout, `Created run ${res.body.runId}${replayed}`);
      writeLine(ctx.io.stdout, `Final status: ${snap.status}`);
    }
    return snap.status === 'completed' ? 0 : 1;
  }
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Created run ${res.body.runId} (${res.body.status})${replayed}`);
  return 0;
}

async function runRunsGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs get <runId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}`);
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else {
    writeLine(ctx.io.stdout, `runId: ${res.body.runId}`);
    writeLine(ctx.io.stdout, `workflowId: ${res.body.workflowId}`);
    writeLine(ctx.io.stdout, `status: ${res.body.status}`);
  }
  return 0;
}

async function runRunsCancel(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--reason'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs cancel <runId> [--reason text] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body = options.reason ? { reason: options.reason } : {};
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/cancel`, { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Cancelled ${positionals[0]}`);
  return 0;
}

/** POST /v1/runs/{id}:fork — replay/branch a run from a sequence (RFC 0054). */
async function runRunsFork(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--mode', '--from-sequence', '--idempotency-key'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs fork <runId> [--mode replay|branch] [--from-sequence n] [--idempotency-key k] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, unknown> = {};
  if (options.mode) body.mode = String(options.mode);
  if (options.fromSequence !== undefined) body.fromSeq = Number(options.fromSequence);
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}:fork`, { method: 'POST', body, headers: idempotencyHeaders(options.idempotencyKey) });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Forked ${positionals[0]} → ${res.body?.runId ?? '(see --json)'}`);
  return 0;
}

/** GET /v1/runs/{id}:diff?against={other} — a deterministic structured diff (RFC 0054). */
async function runRunsDiff(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--against'] });
  if (options.help || positionals.length !== 1 || !options.against) {
    write(ctx.io.stdout, 'Usage: openwop runs diff <runId> --against <otherRunId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(
    ctx,
    `/v1/runs/${encodeURIComponent(positionals[0])}:diff?against=${encodeURIComponent(String(options.against))}`,
  );
  writeJson(ctx.io.stdout, res.body); // a diff is inherently structured
  return 0;
}

/** DELETE /v1/runs/{id} — remove a run + its event log (guarded). */
async function runRunsDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs delete <runId> [--yes]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) throw new CliError(`Refusing to delete run ${positionals[0]} without --yes (this removes the run and its event log).`, 2);
  await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted ${positionals[0]}`);
  return 0;
}

/** POST /v1/runs:bulk-cancel — cancel many runs in one call. */
async function runRunsBulkCancel(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--reason'] });
  if (options.help || positionals.length === 0) {
    write(ctx.io.stdout, 'Usage: openwop runs bulk-cancel <runId...> [--reason text] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, unknown> = { runIds: positionals };
  if (options.reason) body.reason = options.reason;
  const res = await requestJson(ctx, '/v1/runs:bulk-cancel', { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Requested cancel of ${positionals.length} run(s)`);
  return 0;
}

async function runRunsEvents(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--follow', '--no-stream'], value: ['--since', '--limit', '--last-event-id', '--stream-mode', '--timeout-ms', '--idle-timeout-ms'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs events <runId> [--since <sequence>] [--limit <n>] [--json]\n       openwop runs events <runId> --follow [--since <sequence> | --last-event-id <id>] [--stream-mode <mode>] [--no-stream] [--json]\n');
    return options.help ? 0 : 2;
  }
  if (options.follow) return followRunEvents(ctx, positionals[0], options);
  if (options.lastEventId !== undefined || options.streamMode !== undefined) {
    throw new CliError('--last-event-id and --stream-mode apply to the SSE stream: add --follow');
  }
  const query = new URLSearchParams();
  if (options.since !== undefined) query.set(await pollCursorParam(ctx), String(options.since));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const qs = query.toString();
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/events/poll${qs ? `?${qs}` : ''}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const events = Array.isArray(res.body?.events) ? res.body.events : [];
  if (events.length === 0) { writeLine(ctx.io.stdout, 'No events.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    events.map((e: any) => ({ seq: String(e.sequence), type: e.type, nodeId: e.nodeId ?? '', timestamp: e.timestamp ?? '' })),
    ['seq', 'type', 'nodeId', 'timestamp'],
  ));
  if (pollIsTerminal(res.body)) writeLine(ctx.io.stdout, '(run complete)');
  return 0;
}

/** `runs events --follow` / `runs watch` — SSE with Last-Event-ID resume, poll fallback. */
async function followRunEvents(ctx: Ctx, runId: string, options: Record<string, any>) {
  const start = await parseStreamStart(ctx, options);
  let terminalType: string | undefined;
  const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : 30 * 60 * 1000;
  await streamRunEvents(ctx, runId, {
    ...start,
    useStream: !options.noStream,
    timeoutMs,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: nonNegativeInt(options.idleTimeoutMs, '--idle-timeout-ms') } : {}),
    onEvent: (ev: any) => {
      if (isTerminalRunEvent(ev)) terminalType = canonicalEventType(ev.type);
      if (ctx.json) { writeLine(ctx.io.stdout, JSON.stringify(ev)); return; }
      const line = renderEvent(ev);
      if (line) writeLine(ctx.io.stdout, typeof ev.sequence === 'number' ? `[${ev.sequence}] ${line}` : line);
    },
  });
  return terminalType === 'run.failed' || terminalType === 'run.cancelled' ? 1 : 0;
}

async function runRunsAnnotations(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs annotations <runId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/annotations`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const annotations = Array.isArray(res.body?.annotations) ? res.body.annotations : [];
  if (annotations.length === 0) { writeLine(ctx.io.stdout, 'No annotations. Add one with `openwop runs annotate <runId> --rating 5`.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    annotations.map((a: any) => ({
      annotationId: a.annotationId,
      kind: a.signal?.kind ?? '',
      detail: a.signal?.rating ?? a.signal?.label ?? a.signal?.correction ?? '',
      note: a.note ?? '',
      createdAt: a.createdAt ?? '',
    })),
    ['annotationId', 'kind', 'detail', 'note', 'createdAt'],
  ));
  return 0;
}

async function runRunsAnnotate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--flag'],
    value: ['--rating', '--label', '--correction', '--note', '--event-id', '--node-id'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs annotate <runId> (--rating 1-5 | --label <text> | --correction <text> | --flag) [--note text] [--event-id id] [--node-id id] [--json]\n');
    return options.help ? 0 : 2;
  }
  // Exactly one signal kind.
  const signal: Record<string, unknown> = {};
  if (options.rating !== undefined) { signal.kind = 'rating'; signal.rating = Number(options.rating); }
  else if (options.label !== undefined) { signal.kind = 'label'; signal.label = options.label; }
  else if (options.correction !== undefined) { signal.kind = 'correction'; signal.correction = options.correction; }
  else if (options.flag) { signal.kind = 'flag'; }
  else throw new CliError('one of --rating, --label, --correction, or --flag is required.');

  const target: Record<string, unknown> = {};
  if (options.eventId) target.eventId = options.eventId;
  if (options.nodeId) target.nodeId = options.nodeId;
  const body = {
    signal,
    ...(Object.keys(target).length ? { target } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/annotations`, { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `✓ Annotation ${res.body.annotationId} (${res.body.signal?.kind}) on ${positionals[0]}`);
  return 0;
}

async function runRunsDebugBundle(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--max-events', '--out'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs debug-bundle <runId> [--max-events <n>] [--out <file>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const query = new URLSearchParams();
  if (options.maxEvents !== undefined) query.set('maxEvents', String(options.maxEvents));
  const qs = query.toString();
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/debug-bundle${qs ? `?${qs}` : ''}`);
  if (options.out) {
    writeFileSync(options.out, JSON.stringify(res.body, null, 2) + '\n', 'utf8');
    if (!ctx.quiet) writeLine(ctx.io.stdout, `✓ Wrote debug bundle for ${res.body.runId} → ${options.out} (${(res.body.events ?? []).length} events${res.body.truncated ? ', truncated' : ''})`);
    return 0;
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `runId: ${res.body.runId}`);
  writeLine(ctx.io.stdout, `workflowId: ${res.body.workflowId}`);
  writeLine(ctx.io.stdout, `status: ${res.body.status}`);
  writeLine(ctx.io.stdout, `events: ${(res.body.events ?? []).length}${res.body.truncated ? ' (truncated)' : ''}`);
  writeLine(ctx.io.stdout, 'Pass --out <file> to save the full bundle, or --json to print it.');
  return 0;
}

async function runRunsAncestry(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs ancestry <runId> [--json]\n');
    return options.help ? 0 : 2;
  }
  // RFC 0040 §C — GET /v1/runs/{runId}/ancestry. Each run carries a single
  // cross-host parent link (`parent`), so the ancestry is a linear chain.
  // Walk it from the requested run up to the top-level root, following the
  // same-host `parent.runId` until `parent === null`. A depth cap guards
  // against a malformed cycle. The endpoint is opt-in (Phase 3) and returns
  // 404 when not advertised — surface that as a clear message.
  const chain: any[] = [];
  let current = encodeURIComponent(positionals[0]);
  const MAX_DEPTH = 64;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let res;
    try {
      res = await requestJson(ctx, `/v1/runs/${current}/ancestry`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Distinguish "endpoint not enabled" from "run not found" via the body.
        const detail = err.body && typeof err.body === 'object' && typeof (err.body as { message?: string }).message === 'string'
          ? (err.body as { message?: string }).message
          : 'not found';
        throw new CliError(`runs ancestry unavailable: ${detail} (the ancestry endpoint is opt-in; the host must advertise crossHostCausation.ancestryEndpointSupported).`, 2);
      }
      throw err;
    }
    chain.push(res.body);
    const parent = res.body.parent;
    if (!parent || typeof parent.runId !== 'string') break;
    // A cross-host parent (with wellKnownUrl) can't be walked over this host;
    // record the link and stop.
    if (parent.wellKnownUrl) break;
    current = encodeURIComponent(parent.runId);
  }

  if (ctx.json) {
    writeJson(ctx.io.stdout, { runId: positionals[0], chain });
    return 0;
  }

  // Render the chain root → requested run as a table, oldest ancestor first.
  const ordered = [...chain].reverse();
  const rows = ordered.map((node, i) => {
    const parent = node.parent;
    return {
      depth: ordered.length - 1 - i,
      runId: node.runId,
      hostId: node.hostId ?? '',
      parentRunId: parent && typeof parent.runId === 'string' ? parent.runId : '(root)',
      cause: parent && typeof parent.cause === 'string' ? parent.cause : '',
    };
  });
  writeLine(ctx.io.stdout, formatTable(rows, ['depth', 'runId', 'hostId', 'parentRunId', 'cause']));
  return 0;
}

async function waitForRun(ctx: Ctx, runId: any, timeoutMs: any) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(runId)}`);
    if (TERMINAL_STATUSES.has(res.body.status)) return res.body;
    await sleep(250);
  }
  throw new CliError(`Timed out waiting for run ${runId} after ${timeoutMs}ms`, 1);
}

/** GET /v1/runs/{runId}/effects — the run's effect ledger (idempotency.md §Layer 2). */
async function runRunsEffects(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs effects <runId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/effects`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const effects = Array.isArray(res.body?.effects) ? res.body.effects : [];
  if (effects.length === 0) { writeLine(ctx.io.stdout, `No recorded effects for run ${positionals[0]}.`); return 0; }
  writeLine(ctx.io.stdout, formatTable(effects.map((e: any) => ({
    effectId: e.effectId ?? '',
    nodeId: e.nodeId ?? '',
    attempt: e.attempt === undefined ? '' : String(e.attempt),
    state: e.state ?? '',
    at: e.at ?? '',
  })), ['effectId', 'nodeId', 'attempt', 'state', 'at']));
  return 0;
}

/** GET /v1/host/openwop-app/runs/{runId}/revision — pinned revision + provenance (ADR 0474/0475). */
async function runRunsRevision(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop runs revision <runId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/host/openwop-app/runs/${await hostRunSegment(ctx, positionals[0])}/revision`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const r = res.body ?? {};
  writeLine(ctx.io.stdout, `runId: ${r.runId ?? positionals[0]}`);
  writeLine(ctx.io.stdout, `workflowId: ${r.workflowId ?? ''}`);
  writeLine(ctx.io.stdout, `definitionRevision: ${r.definitionRevision ?? '(not pinned)'}`);
  if (r.definitionResolvedFrom) writeLine(ctx.io.stdout, `resolvedFrom: ${r.definitionResolvedFrom}`);
  if (r.headMoved !== undefined) writeLine(ctx.io.stdout, `headMoved: ${r.headMoved ? 'yes' : 'no'}`);
  if (r.launch) writeLine(ctx.io.stdout, `launch: ${r.launch}${r.launchResolved ? ` (${r.launchResolved})` : ''}`);
  if (r.debug) writeLine(ctx.io.stdout, `debug: ${JSON.stringify(r.debug)}`);
  if (r.redriveOf) writeLine(ctx.io.stdout, `redriveOf: ${r.redriveOf}`);
  return 0;
}

/** POST /v1/host/openwop-app/runs/{runId}/pin — { pinned } (default true). */
async function runRunsPin(ctx: Ctx, argv: string[], pinned: boolean) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop runs ${pinned ? 'pin' : 'unpin'} <runId> [--json]\n`);
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/host/openwop-app/runs/${await hostRunSegment(ctx, positionals[0])}/pin`, { method: 'POST', body: { pinned } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `${res.body?.pinned === false ? 'Unpinned' : 'Pinned'} run ${res.body?.runId ?? positionals[0]}.`);
  return 0;
}

/** POST /v1/host/openwop-app/runs/redrive — { runIds } (1–25). Exit 1 when any id failed. */
async function runRunsRedrive(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length === 0) {
    write(ctx.io.stdout, 'Usage: openwop runs redrive <runId...> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/runs/redrive', { method: 'POST', body: { runIds: positionals } });
  const results = Array.isArray(res.body?.results) ? res.body.results : [];
  const anyFailed = results.some((r: any) => !r.redriveRunId);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return anyFailed ? 1 : 0; }
  writeLine(ctx.io.stdout, formatTable(results.map((r: any) => ({
    runId: r.runId ?? '',
    redriveRunId: r.redriveRunId ?? '',
    error: r.error ?? '',
  })), ['runId', 'redriveRunId', 'error']));
  return anyFailed ? 1 : 0;
}

function nonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`${flag} must be a non-negative integer (got ${String(value)})`);
  return n;
}
