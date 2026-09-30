import type { Ctx } from '../context.js';
/** `openwop interrupts ...` — list a run's open interrupts; inspect/resolve by token; resolve by run+node (interrupt.md, RFC 0093). */

import { requestJson } from '../api.js';
import { CliError, HttpError, errorEnvelope } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { idempotencyHeaders } from '../wire.js';

export const INTERRUPTS_HELP = `Usage:
  openwop interrupts list <runId> [--json]
  openwop interrupts resolve <token> [--data-json '{...}'] [--idempotency-key k] [--json]
  openwop interrupts inspect <token> [--json]
  openwop interrupts respond <runId> <nodeId> [--data-json '{...}'] [--idempotency-key k] [--json]

List a run's open interrupts (human-in-the-loop / approval pauses) and resolve
one by its capability token (POST /v1/interrupts/{token}; /interrupts/{token}
under protocol v2). \`--data-json\` is the resume value (validated against the
interrupt's resumeSchema by the host); it is sent as the closed body
\`{ "resumeValue": <data> }\` both majors require. A payload that is already
exactly \`{ "resumeValue": ... }\` is sent as-is. Every resolve carries an
Idempotency-Key (interrupt.md §Resolve surfaces).

\`inspect\` reads an interrupt by its token without resolving it
(GET /v1/interrupts/{token}; /interrupts/{token} under v2): kind, resumeSchema,
data, expiry and whether it is already resolved. A resolved interrupt stays
inspectable; an expired token is 410 and a finished run 409.

\`respond\` resolves the open interrupt on one node of a run you own
(POST /v1/runs/{runId}/interrupts/{nodeId}; /runs/{runId}/interrupts/{nodeId}
under v2) with the same \`{ "resumeValue": ... }\` body. It needs the
approvals:respond scope (exit 4 without it); no open interrupt on that node is
404, and under v2 a finished run is 409 interrupt_already_resolved.

\`list\` reads the host-extension GET /v1/host/openwop-app/runs/{runId}/interrupts.

Exit codes: 0 ok · 1 not found / expired / already resolved · 2 usage · 4 not allowed.

Examples:
  openwop interrupts list run_123
  openwop interrupts inspect tok_abc --json
  openwop interrupts resolve tok_abc --data-json '{"action":"approve"}'
  openwop interrupts respond run_123 approve-node --data-json '{"action":"reject"}'
`;

export async function runInterrupts(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, INTERRUPTS_HELP); return sub ? 0 : 2; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': {
      if (rest.length !== 1) { write(ctx.io.stdout, 'Usage: openwop interrupts list <runId> [--json]\n'); return 2; }
      let res;
      try {
        res = await requestJson(ctx, `/v1/host/openwop-app/runs/${encodeURIComponent(rest[0])}/interrupts`);
      } catch (err) {
        // A host that does not serve the openwop-app extension answers "no
        // operation at …" (not a missing run). Fail closed, legibly, and name
        // what works on any host instead of printing a bare 404.
        const env = err instanceof HttpError ? errorEnvelope(err.body) : {};
        if (err instanceof HttpError && err.status === 404 && /^no operation at /i.test(env.message ?? '')) {
          throw new CliError(
            'interrupts: `list` reads the openwop-app host extension (GET /v1/host/openwop-app/runs/{runId}/interrupts), which this host does not serve. '
              + 'On any host an open interrupt appears as interrupt.requested in the run\'s events; answer it with `openwop interrupts respond <runId> <nodeId>`.',
            1,
          );
        }
        throw err;
      }
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.interrupts) ? res.body.interrupts : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, `No open interrupts for run ${rest[0]}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(
        items.map((i: any) => ({ nodeId: i.nodeId, kind: i.kind, token: i.token, createdAt: i.createdAt ?? '' })),
        ['nodeId', 'kind', 'token', 'createdAt'],
      ));
      return 0;
    }
    case 'resolve': {
      const { options, positionals } = parseOptions(rest, { value: ['--data-json', '--idempotency-key'] });
      if (positionals.length !== 1) { write(ctx.io.stdout, "Usage: openwop interrupts resolve <token> [--data-json '{...}'] [--idempotency-key k] [--json]\n"); return 2; }
      let resumeValue: unknown = {};
      if (options.dataJson) {
        try { resumeValue = JSON.parse(options.dataJson); } catch { throw new CliError('--data-json must be valid JSON.'); }
      }
      const res = await requestJson(ctx, `/v1/interrupts/${encodeURIComponent(positionals[0])}`, {
        method: 'POST',
        body: resumeBody(resumeValue),
        headers: idempotencyHeaders(options.idempotencyKey),
      });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `✓ Resolved interrupt — run ${res.body.runId} node ${res.body.nodeId} (${res.body.status ?? 'running'})`);
      return 0;
    }
    case 'inspect': {
      const { options, positionals } = parseOptions(rest, { bool: ['--help'] });
      if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop interrupts inspect <token> [--json]\n'); return options.help ? 0 : 2; }
      let res;
      try {
        res = await requestJson(ctx, `/v1/interrupts/${encodeURIComponent(positionals[0])}`);
      } catch (err) {
        lifecycleError(err);
      }
      const b = res.body ?? {};
      if (ctx.json) { writeJson(ctx.io.stdout, b); return 0; }
      writeLine(ctx.io.stdout, `kind: ${b.kind ?? ''}`);
      if (b.key) writeLine(ctx.io.stdout, `key: ${b.key}`);
      writeLine(ctx.io.stdout, `resolved: ${b.resolved ? 'yes' : 'no'}`);
      if (b.expiresAt) writeLine(ctx.io.stdout, `expiresAt: ${b.expiresAt}`);
      const prompt = b.data && typeof b.data === 'object' ? (b.data as { prompt?: unknown }).prompt : undefined;
      if (typeof prompt === 'string') writeLine(ctx.io.stdout, `prompt: ${prompt}`);
      if (b.resumeSchema !== undefined) writeLine(ctx.io.stdout, `resumeSchema: ${JSON.stringify(b.resumeSchema)}`);
      return 0;
    }
    case 'respond': {
      const { options, positionals } = parseOptions(rest, { bool: ['--help'], value: ['--data-json', '--idempotency-key'] });
      if (options.help || positionals.length !== 2) { write(ctx.io.stdout, "Usage: openwop interrupts respond <runId> <nodeId> [--data-json '{...}'] [--idempotency-key k] [--json]\n"); return options.help ? 0 : 2; }
      let resumeValue: unknown = {};
      if (options.dataJson) {
        try { resumeValue = JSON.parse(options.dataJson); } catch { throw new CliError('--data-json must be valid JSON.'); }
      }
      let res;
      try {
        res = await requestJson(ctx, `/v1/runs/${encodeURIComponent(positionals[0])}/interrupts/${encodeURIComponent(positionals[1])}`, {
          method: 'POST',
          body: resumeBody(resumeValue),
          headers: idempotencyHeaders(options.idempotencyKey),
        });
      } catch (err) {
        lifecycleError(err);
      }
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `✓ Resolved interrupt — run ${res.body?.runId ?? positionals[0]} node ${res.body?.nodeId ?? positionals[1]} (${res.body?.status ?? 'running'})`);
      return 0;
    }
    default:
      throw new CliError(`Unknown interrupts command: ${sub}\nRun \`openwop interrupts --help\` for usage.`);
  }
}

/**
 * The resolve body — `{ resumeValue }`, closed (`additionalProperties: false`)
 * in both `api/openapi.yaml` (v1) and `api/v2/openapi.yaml`. A value that is
 * already exactly that envelope passes through, so a caller who wrapped it
 * themselves is not double-wrapped.
 */
export function resumeBody(value: unknown): { resumeValue: unknown } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'resumeValue') return value as { resumeValue: unknown };
  }
  return { resumeValue: value };
}

/** 404 / 409 / 410 are the interrupt lifecycle answers (RFC 0093 §B): render them legibly, exit 1. */
function lifecycleError(err: unknown): never {
  if (err instanceof HttpError && (err.status === 404 || err.status === 409 || err.status === 410)) {
    const env = errorEnvelope(err.body);
    const what = err.status === 404 ? 'no open interrupt there (unknown token, or nothing is waiting on that node)'
      : err.status === 410 ? 'the interrupt has expired'
      : 'the interrupt is already resolved, or its run has finished';
    throw new CliError(`interrupts: ${what} — HTTP ${err.status}${env.code ? ` ${env.code}` : ''}${env.message ? `: ${env.message}` : ''}`, 1);
  }
  throw err;
}
