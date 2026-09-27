import type { Ctx } from '../context.js';
/**
 * `openwop agent-author …` — the AI agent author's stashed draft (openwop-app
 * agent-author feature; the chat-drivable authoring pattern of ADR 0058).
 *
 * When the Agent Architect drafts an agent in chat, the draft is stashed per
 * signed-in user so it survives a reload:
 *   GET    /v1/host/openwop-app/agent-author/draft  → { draft, stashedAt } | { draft: null }
 *   DELETE /v1/host/openwop-app/agent-author/draft  → dismiss it (idempotent)
 * An anonymous caller has no durable identity and therefore never has a draft.
 */
import { CliError } from '../errors.js';
import { write, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { emit } from './chatShared.js';

const DRAFT = '/v1/host/openwop-app/agent-author/draft';

export const AGENT_AUTHOR_HELP = `Usage:
  openwop agent-author draft [--json]
  openwop agent-author clear

The agent draft the AI Agent Architect stashed for you in chat:
GET /v1/host/openwop-app/agent-author/draft (read) and DELETE (dismiss). Talk to
the architect itself in the main chat (\`openwop chat open --subject agent:<id>\`).
Signed-out callers never have a stashed draft.

Examples:
  openwop agent-author draft --json
  openwop agent-author clear
`;

export async function runAgentAuthor(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'draft';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_AUTHOR_HELP); return 0; }
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, AGENT_AUTHOR_HELP); return 0; }
  if (sub === 'draft' || sub === 'get') {
    const res = await requestJson(ctx, DRAFT);
    return emit(ctx, res.body, () => {
      if (!res.body?.draft) { writeLine(ctx.io.stdout, 'No stashed agent draft.'); return; }
      writeLine(ctx.io.stdout, `stashedAt: ${res.body.stashedAt ?? ''}`);
      writeLine(ctx.io.stdout, JSON.stringify(res.body.draft, null, 2));
    });
  }
  if (sub === 'clear' || sub === 'delete') {
    await requestJson(ctx, DRAFT, { method: 'DELETE' });
    writeLine(ctx.io.stdout, 'Cleared the stashed agent draft.');
    return 0;
  }
  throw new CliError(`Unknown agent-author command: ${sub}\nRun \`openwop agent-author --help\` for usage.`, 2);
}
