import type { Ctx } from '../context.js';
/**
 * `openwop workflow-author …` — AI workflow authoring (openwop-app ADR 0072 AI
 * workflow authoring; ADR 0472 P4 chain-backed meta-workflow; ADR 0595/0596
 * honest draft → validate → persist).
 *
 *   GET  /v1/host/openwop-app/workflow-author/catalog — the node menu the author may use
 *   POST /v1/host/openwop-app/workflow-author/draft   — start the authoring meta-workflow
 *        run from a natural-language intent → { runId, workflowId, status, eventsUrl }
 *
 * The draft is an ordinary run on the normative surface, so `--follow` streams
 * it through the same run-event reader `openwop runs` / `chat` use (src/sse.ts);
 * the persist node's output carries the authored workflowId. The host's run
 * quota applies (429 when exhausted).
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { renderEvent, streamRunEvents } from '../sse.js';
import { idempotencyHeaders } from '../wire.js';
import { emit, intFlag } from './chatShared.js';

const BASE = '/v1/host/openwop-app/workflow-author';

export const WORKFLOW_AUTHOR_HELP = `Usage:
  openwop workflow-author catalog [--json]
  openwop workflow-author draft --intent <text> [--provider p] [--model m] [--max-attempts n]
                                [--follow] [--timeout-ms ms] [--idempotency-key k] [--json]

Author a workflow from plain language on the server.
  catalog  GET /v1/host/openwop-app/workflow-author/catalog — the nodes the author may
           use in this workspace (and which were excluded, with why).
  draft    POST /v1/host/openwop-app/workflow-author/draft — starts the authoring run and
           prints its runId. --follow streams the run's events until it finishes
           (default timeout 120000 ms); otherwise follow later with
           \`openwop runs events <runId>\`. The authored workflow opens in the builder.

Exit codes: 0 ok, 2 usage, 4 not permitted, 1 server error; 429 when the run
quota is exhausted (retry after the Retry-After interval).

Examples:
  openwop workflow-author catalog
  openwop workflow-author draft --intent "Every Monday, summarize open support tickets and email me" --follow
`;

export async function runWorkflowAuthor(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, WORKFLOW_AUTHOR_HELP); return sub ? 0 : 2; }
  const { options } = parseOptions(argv.slice(1), {
    bool: ['--help', '--follow'],
    value: ['--intent', '--provider', '--model', '--max-attempts', '--timeout-ms', '--idempotency-key'],
  });
  if (options.help) { write(ctx.io.stdout, WORKFLOW_AUTHOR_HELP); return 0; }
  if (sub === 'catalog') {
    const res = await requestJson(ctx, `${BASE}/catalog`);
    return emit(ctx, res.body, () => {
      const nodes = Array.isArray(res.body?.nodes) ? res.body.nodes : [];
      if (!nodes.length) writeLine(ctx.io.stdout, 'No authorable nodes in this workspace.');
      else writeLine(ctx.io.stdout, formatTable(nodes.map((n: any) => ({ typeId: n.typeId, version: n.version ?? '', category: n.category ?? '', role: n.role ?? '', label: n.label ?? '' })), ['typeId', 'version', 'category', 'role', 'label']));
      const excluded = Array.isArray(res.body?.excluded) ? res.body.excluded : [];
      if (excluded.length) writeLine(ctx.io.stdout, `(${excluded.length} node type(s) excluded — see --json for reasons)`);
    });
  }
  if (sub === 'draft') {
    if (!options.intent) throw new CliError('workflow-author draft requires --intent <text>.', 2);
    const body: Record<string, any> = { intent: options.intent };
    if (options.provider) body.provider = options.provider;
    if (options.model) body.model = options.model;
    const maxAttempts = intFlag(options.maxAttempts, '--max-attempts');
    if (maxAttempts) body.maxAttempts = maxAttempts;
    const res = await requestJson(ctx, `${BASE}/draft`, { method: 'POST', body, headers: idempotencyHeaders(options.idempotencyKey) });
    const runId = res.body?.runId;
    if (!options.follow) {
      return emit(ctx, res.body, () => {
        writeLine(ctx.io.stdout, `Authoring run ${runId} started (${res.body?.status ?? 'pending'}).`);
        writeLine(ctx.io.stdout, `Follow it: openwop runs events ${runId}`);
      });
    }
    if (!ctx.json) writeLine(ctx.io.stdout, `Authoring run ${runId} started — streaming events…`);
    await streamRunEvents(ctx, String(runId), {
      timeoutMs: intFlag(options.timeoutMs, '--timeout-ms') ?? 120000,
      onEvent: (ev: any) => {
        if (ctx.json) { writeJson(ctx.io.stdout, ev); return; }
        const line = renderEvent(ev);
        if (line) writeLine(ctx.io.stdout, line);
      },
    });
    return 0;
  }
  throw new CliError(`Unknown workflow-author command: ${sub}\nRun \`openwop workflow-author --help\` for usage.`, 2);
}
