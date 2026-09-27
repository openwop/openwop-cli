import type { Ctx } from '../context.js';
/**
 * Workflow lifecycle, revision, debug and eval subcommands of `openwop workflows`
 * (host-extension, /v1/host/openwop-app/workflows/{workflowId}/…):
 *
 *  - lifecycle — archive / unarchive / promote (openwop-app ADR 0369; promote =
 *    publish = pin the head revision, ADR 0474, gated on a green run + any
 *    required eval sets, ADR 0477)
 *  - revisions / rollback (ADR 0474 append-only revision history)
 *  - stats / estimate (ADR 0476 fleet insights + pre-run cost estimate)
 *  - pins / debug-run (ADR 0475 step debugging over pinned node outputs)
 *  - eval-sets (ADR 0477 offline eval sets, ADR 0480 online trend)
 *
 * The host owns every gate (owner-only, uniform 404 for a foreign workflow);
 * the CLI relays and renders.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { buildInputs } from './shared.js';
import { readBodyOption, parseJsonFlag } from './contentHelpers.js';

const WF = '/v1/host/openwop-app/workflows';
const wf = (id: string) => `${WF}/${encodeURIComponent(id)}`;

export const WORKFLOW_OPS_HELP = `Workflow lifecycle, revisions, debugging and evals (host-extension):
  openwop workflows archive|unarchive|promote <workflowId> [--json]
  openwop workflows revisions <workflowId> [--json]
  openwop workflows rollback <workflowId> --revision <hash> [--json]
  openwop workflows stats [--json]
  openwop workflows estimate <workflowId> [--json]
  openwop workflows pins <workflowId> [--json]
  openwop workflows pin-set <workflowId> <nodeId> --output-json '{...}' [--json]
  openwop workflows pin-delete <workflowId> <nodeId> [--json]
  openwop workflows pins-clear <workflowId> [--yes] [--json]
  openwop workflows pins-from-run <workflowId> <runId> [--json]
  openwop workflows debug-run <workflowId> --from-node <nodeId> [--mode from-here|only] [--input k=v]... [--inputs-json J] [--json]
  openwop workflows eval-sets <workflowId> [--json]
  openwop workflows eval-set get <workflowId> <evalSetId> [--json]
  openwop workflows eval-set put <workflowId> <evalSetId> (--body '{...}' | --body-file <f>) [--json]
  openwop workflows eval-set delete <workflowId> <evalSetId> [--yes] [--json]
  openwop workflows eval-set run <workflowId> <evalSetId> [--json]
  openwop workflows eval-set online <workflowId> <evalSetId> [--json]
  openwop workflows eval-results <workflowId> [--eval-set <evalSetId>] [--json]

  archive/unarchive/promote  POST …/workflows/{id}/{verb}. promote publishes the
                     head (pins it as the published revision); the host refuses it
                     until the draft has one successful non-debug run and every
                     eval set marked requiredForPromote is green (409).
  revisions          GET  …/workflows/{id}/revisions — newest first (≤100), marking
                     the head and the published revision.
  rollback           POST …/workflows/{id}/rollback { revisionHash } — restores that
                     revision AS the new head (history stays append-only).
  stats              GET  …/workflows/stats — tenant fleet stats for the disclosed window.
  estimate           GET  …/workflows/{id}/estimate — historical run cost + a static floor.
  pins               GET  …/workflows/{id}/pins — pinned node outputs used by debug runs.
  pin-set            PUT  …/workflows/{id}/pins/{nodeId} { output }
  pin-delete         DELETE …/workflows/{id}/pins/{nodeId}
  pins-clear         DELETE …/workflows/{id}/pins
  pins-from-run      POST …/workflows/{id}/pins/from-run { runId } — pins every completed
                     node output of one of your runs (reports unmatched/skipped nodes).
  debug-run          POST …/workflows/{id}/debug-run { fromNodeId, mode, inputs } — runs
                     from a node over the pins (422 names any missing pin). Counts
                     against your run quota like any run.
  eval-sets / eval-set …   GET/PUT/DELETE …/workflows/{id}/eval-sets[/{evalSetId}],
                     POST …/eval-sets/{evalSetId}/run (202; one run per case, each
                     charged to your run quota), GET …/eval-sets/{evalSetId}/online.
                     put REPLACES the set: pass the whole { name, cases[], requiredForPromote?, online? }.
  eval-results       GET  …/workflows/{id}/eval-results[?evalSetId=] — latest 50 results.
`;

/** Subcommand names this module owns (the workflows dispatcher routes these here). */
export const WORKFLOW_OPS_SUBS = [
  'archive', 'unarchive', 'promote', 'revisions', 'rollback', 'stats', 'estimate',
  'pins', 'pin-set', 'pin-delete', 'pins-clear', 'pins-from-run', 'debug-run',
  'eval-sets', 'eval-set', 'eval-results',
];

export async function runWorkflowOps(ctx: Ctx, sub: string, argv: string[]): Promise<number> {
  if (sub === 'eval-set') return runEvalSet(ctx, argv);
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--yes'],
    value: ['--revision', '--output-json', '--from-node', '--mode', '--inputs-json', '--eval-set'],
    multi: ['--input'],
  });
  if (options.help) { write(ctx.io.stdout, WORKFLOW_OPS_HELP); return 0; }
  const need = (n: number, usage: string) => {
    if (positionals.length !== n) throw new CliError(`Usage: openwop workflows ${sub} ${usage}`, 2);
  };
  const out = (body: unknown, human: string) => {
    if (ctx.json) writeJson(ctx.io.stdout, body);
    else writeLine(ctx.io.stdout, human);
    return 0;
  };

  switch (sub) {
    case 'archive':
    case 'unarchive':
    case 'promote': {
      need(1, '<workflowId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/${sub}`, { method: 'POST' });
      const past = sub === 'archive' ? 'Archived' : sub === 'unarchive' ? 'Unarchived' : 'Promoted';
      return out(res.body, `${past} ${positionals[0]}${res.body?.publishedRevision ? ` (published revision ${res.body.publishedRevision})` : ''}.`);
    }
    case 'revisions': {
      need(1, '<workflowId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/revisions`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, `No revisions recorded for ${positionals[0]}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((r: any) => ({
        revisionHash: r.revisionHash ?? '',
        createdAt: r.createdAt ?? '',
        nodes: r.nodeCount === undefined ? '' : String(r.nodeCount),
        head: r.isHead ? 'yes' : '',
        published: r.published ? 'yes' : '',
        createdBy: r.createdBy ?? '',
      })), ['revisionHash', 'createdAt', 'nodes', 'head', 'published', 'createdBy']));
      return 0;
    }
    case 'rollback': {
      need(1, '<workflowId> --revision <hash> [--json]');
      if (!options.revision) throw new CliError('rollback needs --revision <hash> (see `openwop workflows revisions <id>`).', 2);
      const res = await requestJson(ctx, `${wf(positionals[0])}/rollback`, { method: 'POST', body: { revisionHash: options.revision } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Restored ${positionals[0]} to revision ${res.body?.restoredRevision ?? options.revision}.`);
      const removed = res.body?.removedReferencedNodeIds;
      if (Array.isArray(removed) && removed.length) writeLine(ctx.io.stdout, `Note: nodes past runs referenced are gone from the head: ${removed.join(', ')}`);
      return 0;
    }
    case 'stats': {
      need(0, '[--json]');
      const res = await requestJson(ctx, `${WF}/stats`);
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'estimate': {
      need(1, '<workflowId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/estimate`);
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'pins': {
      need(1, '<workflowId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/pins`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, `No pinned outputs on ${positionals[0]}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((p: any) => ({
        nodeId: p.nodeId ?? '',
        sourceRunId: p.sourceRunId ?? '',
        createdAt: p.createdAt ?? '',
        output: JSON.stringify(p.output ?? null).slice(0, 60),
      })), ['nodeId', 'sourceRunId', 'createdAt', 'output']));
      return 0;
    }
    case 'pin-set': {
      need(2, "<workflowId> <nodeId> --output-json '{...}' [--json]");
      if (options.outputJson === undefined) throw new CliError('pin-set needs --output-json holding the node output object.', 2);
      const output = parseJsonFlag('--output-json', options.outputJson);
      const res = await requestJson(ctx, `${wf(positionals[0])}/pins/${encodeURIComponent(positionals[1])}`, { method: 'PUT', body: { output } });
      return out(res.body, `Pinned an output on node ${positionals[1]}.`);
    }
    case 'pin-delete': {
      need(2, '<workflowId> <nodeId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/pins/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' });
      return out(res.body, res.body?.removed === false ? `No pin on node ${positionals[1]}.` : `Removed the pin on node ${positionals[1]}.`);
    }
    case 'pins-clear': {
      need(1, '<workflowId> [--yes] [--json]');
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to clear every pin on ${positionals[0]} without --yes.`); return 2; }
      const res = await requestJson(ctx, `${wf(positionals[0])}/pins`, { method: 'DELETE' });
      return out(res.body, `Cleared ${res.body?.removed ?? 0} pin(s) on ${positionals[0]}.`);
    }
    case 'pins-from-run': {
      need(2, '<workflowId> <runId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/pins/from-run`, { method: 'POST', body: { runId: positionals[1] } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const b = res.body ?? {};
      writeLine(ctx.io.stdout, `Pinned ${Array.isArray(b.pinned) ? b.pinned.length : 0} node output(s) from run ${positionals[1]}${Array.isArray(b.pinned) && b.pinned.length ? `: ${b.pinned.join(', ')}` : ''}.`);
      if (Array.isArray(b.unmatched) && b.unmatched.length) writeLine(ctx.io.stdout, `Not in the current head: ${b.unmatched.join(', ')}`);
      if (Array.isArray(b.skipped) && b.skipped.length) writeLine(ctx.io.stdout, `Skipped: ${b.skipped.map((x: any) => `${x.nodeId} (${x.reason})`).join(', ')}`);
      return 0;
    }
    case 'debug-run': {
      need(1, '<workflowId> --from-node <nodeId> [--mode from-here|only] [--input k=v]... [--inputs-json J] [--json]');
      if (!options.fromNode) throw new CliError('debug-run needs --from-node <nodeId>.', 2);
      if (options.mode !== undefined && !['from-here', 'only'].includes(options.mode)) throw new CliError('--mode must be from-here or only.', 2);
      const body: Record<string, unknown> = { fromNodeId: options.fromNode };
      if (options.mode) body.mode = options.mode;
      const inputs = buildInputs(options);
      if (Object.keys(inputs).length) body.inputs = inputs;
      const res = await requestJson(ctx, `${wf(positionals[0])}/debug-run`, { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const b = res.body ?? {};
      writeLine(ctx.io.stdout, `Started debug run ${b.runId ?? ''}.`);
      if (Array.isArray(b.executing)) writeLine(ctx.io.stdout, `executing: ${b.executing.join(', ') || '(none)'}`);
      if (Array.isArray(b.pinnedNodes)) writeLine(ctx.io.stdout, `pinned (replayed): ${b.pinnedNodes.join(', ') || '(none)'}`);
      if (Array.isArray(b.skipped) && b.skipped.length) writeLine(ctx.io.stdout, `skipped: ${b.skipped.join(', ')}`);
      return 0;
    }
    case 'eval-sets': {
      need(1, '<workflowId> [--json]');
      const res = await requestJson(ctx, `${wf(positionals[0])}/eval-sets`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, `No eval sets on ${positionals[0]}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((e: any) => ({
        evalSetId: e.evalSetId ?? '',
        name: e.name ?? '',
        cases: Array.isArray(e.cases) ? String(e.cases.length) : '',
        requiredForPromote: e.requiredForPromote ? 'yes' : 'no',
        online: e.online ? 'yes' : 'no',
      })), ['evalSetId', 'name', 'cases', 'requiredForPromote', 'online']));
      return 0;
    }
    case 'eval-results': {
      need(1, '<workflowId> [--eval-set <evalSetId>] [--json]');
      const q = options.evalSet ? `?evalSetId=${encodeURIComponent(options.evalSet)}` : '';
      const res = await requestJson(ctx, `${wf(positionals[0])}/eval-results${q}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No eval results yet.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((r: any) => {
        const cases = Array.isArray(r.cases) ? r.cases : [];
        return {
          resultId: r.resultId ?? '',
          evalSetId: r.evalSetId ?? '',
          status: r.status ?? '',
          passed: `${cases.filter((c: any) => c.status === 'passed').length}/${cases.length}`,
          revision: r.revisionHash ? String(r.revisionHash).slice(0, 12) : '',
          startedAt: r.startedAt ?? '',
        };
      }), ['resultId', 'evalSetId', 'status', 'passed', 'revision', 'startedAt']));
      return 0;
    }
  }
  throw new CliError(`Unknown workflows command: ${sub}`);
}

async function runEvalSet(ctx: Ctx, argv: string[]): Promise<number> {
  const verb = argv[0];
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help', '--yes'], value: ['--body', '--body-file'] });
  if (!verb || options.help || verb === '--help') { write(ctx.io.stdout, WORKFLOW_OPS_HELP); return verb ? 0 : 2; }
  if (positionals.length !== 2) throw new CliError(`Usage: openwop workflows eval-set ${verb} <workflowId> <evalSetId> …`, 2);
  const path = `${wf(positionals[0])}/eval-sets/${encodeURIComponent(positionals[1])}`;
  switch (verb) {
    case 'get': {
      const res = await requestJson(ctx, path);
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'put': {
      const body = readBodyOption(ctx, options);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new CliError('eval-set put needs --body or --body-file holding the whole set: { name, cases[], requiredForPromote?, online? }.', 2);
      }
      const res = await requestJson(ctx, path, { method: 'PUT', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `${res.status === 201 ? 'Created' : 'Replaced'} eval set ${res.body?.evalSetId ?? positionals[1]} (${res.body?.cases ?? '?'} case(s), requiredForPromote: ${res.body?.requiredForPromote ? 'yes' : 'no'}).`);
      return 0;
    }
    case 'delete': {
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete eval set ${positionals[1]} without --yes.`); return 2; }
      const res = await requestJson(ctx, path, { method: 'DELETE' });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, res.body?.removed === false ? `No eval set ${positionals[1]}.` : `Deleted eval set ${positionals[1]}.`);
      return 0;
    }
    case 'run': {
      const res = await requestJson(ctx, `${path}/run`, { method: 'POST' });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Started eval result ${res.body?.resultId ?? ''} (${res.body?.cases ?? '?'} case run(s)). Follow it with \`openwop workflows eval-results ${positionals[0]} --eval-set ${positionals[1]}\`.`);
      return 0;
    }
    case 'online': {
      const res = await requestJson(ctx, `${path}/online`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No online eval buckets yet.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((b: any) => ({
        day: b.day ?? '', evaluated: String(b.evaluated ?? ''), passed: String(b.passed ?? ''), failed: String(b.failed ?? ''),
      })), ['day', 'evaluated', 'passed', 'failed']));
      return 0;
    }
    default:
      throw new CliError(`Unknown workflows eval-set command: ${verb} (get | put | delete | run | online)`);
  }
}
