import type { Ctx } from '../context.js';
/** `openwop interrupts ...` — list open interrupts for a run; resolve by token. */

import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { idempotencyHeaders } from '../wire.js';

export const INTERRUPTS_HELP = `Usage:
  openwop interrupts list <runId> [--json]
  openwop interrupts resolve <token> [--data-json '{...}'] [--idempotency-key k] [--json]

List a run's open interrupts (human-in-the-loop / approval pauses) and resolve
one by its capability token (POST /v1/interrupts/{token}; /interrupts/{token}
under protocol v2). \`--data-json\` is the resume value (validated against the
interrupt's resumeSchema by the host); it is sent as the closed body
\`{ "resumeValue": <data> }\` both majors require. A payload that is already
exactly \`{ "resumeValue": ... }\` is sent as-is. Every resolve carries an
Idempotency-Key (interrupt.md §Resolve surfaces).
`;

export async function runInterrupts(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, INTERRUPTS_HELP); return sub ? 0 : 2; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': {
      if (rest.length !== 1) { write(ctx.io.stdout, 'Usage: openwop interrupts list <runId> [--json]\n'); return 2; }
      const res = await requestJson(ctx, `/v1/host/openwop-app/runs/${encodeURIComponent(rest[0])}/interrupts`);
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
