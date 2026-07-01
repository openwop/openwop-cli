import type { Ctx } from '../context.js';
/** `openwop prompts ...` — prompt-library list/get/render (RFC 0029). */

import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';

export const PROMPTS_HELP = `Usage:
  openwop prompts list [--kind k] [--tag t] [--limit n] [--json]
  openwop prompts get <templateId> [--json]
  openwop prompts render <ref> [--variables-json '{...}'] [--json]
  openwop prompts create --template-id <id> --version <v> --kind <k> --text <t> [--json]
  openwop prompts update <templateId> [--version v] [--kind k] [--text t] [--json]
  openwop prompts delete <templateId> [--yes]

Browse, render, and manage the host's prompt library (RFC 0029, /v1/prompts).
\`render\` resolves a PromptRef (templateId[@version]) against the supplied
variables. \`create\` posts a new PromptTemplate; \`update\` PUTs the fields you
pass to an existing template; \`delete\` removes one.
`;

export async function runPrompts(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PROMPTS_HELP); return 0; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': {
      const { options } = parseOptions(rest, { value: ['--kind', '--tag', '--limit'] });
      const q = new URLSearchParams();
      if (options.kind) q.set('kind', options.kind);
      if (options.tag) q.set('tag', options.tag);
      if (options.limit) q.set('limit', options.limit);
      const res = await requestJson(ctx, `/v1/prompts${q.toString() ? `?${q}` : ''}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No prompt templates.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(
        items.map((t: any) => ({ templateId: t.templateId, kind: t.kind ?? '', modelClass: t.modelClass ?? '', source: t.source ?? '' })),
        ['templateId', 'kind', 'modelClass', 'source'],
      ));
      return 0;
    }
    case 'get': {
      if (rest.length !== 1) { write(ctx.io.stdout, 'Usage: openwop prompts get <templateId> [--json]\n'); return 2; }
      const res = await requestJson(ctx, `/v1/prompts/${encodeURIComponent(rest[0])}`);
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'render': {
      const { options, positionals } = parseOptions(rest, { value: ['--variables-json'] });
      if (positionals.length !== 1) { write(ctx.io.stdout, "Usage: openwop prompts render <ref> [--variables-json '{...}'] [--json]\n"); return 2; }
      let variables = {};
      if (options.variablesJson) {
        try { variables = JSON.parse(options.variablesJson); } catch { throw new CliError('--variables-json must be valid JSON.'); }
      }
      const res = await requestJson(ctx, '/v1/prompts:render', { method: 'POST', body: { ref: positionals[0], variables } });
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'create': {
      const { options } = parseOptions(rest, { value: ['--template-id', '--version', '--kind', '--text'] });
      if (!options.templateId || !options.version || !options.kind || !options.text) {
        write(ctx.io.stderr, 'Usage: openwop prompts create --template-id <id> --version <v> --kind <k> --text <t> [--json]\n');
        return 2;
      }
      const body = { templateId: String(options.templateId), version: String(options.version), kind: String(options.kind), text: String(options.text) };
      const res = await requestJson(ctx, '/v1/prompts', { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body);
      else writeLine(ctx.io.stdout, `Created prompt ${body.templateId}@${body.version}`);
      return 0;
    }
    case 'update': {
      const { options, positionals } = parseOptions(rest, { value: ['--version', '--kind', '--text'] });
      if (positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop prompts update <templateId> [--version v] [--kind k] [--text t] [--json]\n'); return 2; }
      const body: Record<string, unknown> = {};
      if (options.version) body.version = String(options.version);
      if (options.kind) body.kind = String(options.kind);
      if (options.text) body.text = String(options.text);
      const res = await requestJson(ctx, `/v1/prompts/${encodeURIComponent(positionals[0])}`, { method: 'PUT', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body);
      else writeLine(ctx.io.stdout, `Updated prompt ${positionals[0]}`);
      return 0;
    }
    case 'delete': {
      const { options, positionals } = parseOptions(rest, { bool: ['--yes'] });
      if (positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop prompts delete <templateId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete prompt ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `/v1/prompts/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted prompt ${positionals[0]}`);
      return 0;
    }
    default:
      throw new CliError(`Unknown prompts command: ${sub}\nRun \`openwop prompts --help\` for usage.`);
  }
}
