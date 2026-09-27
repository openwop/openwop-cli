import type { Ctx } from '../context.js';
/** `openwop workspaces ...` — B2B workspace-as-tenant list/create/switch (ADR 0015).
 *  NOTE: distinct from `workspace` (singular) — the per-tenant agent FILE workspace. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { gatedRequest, readSecretInput } from './adminShared.js';

export const WORKSPACES_HELP = `Usage:
  openwop workspaces list [--json]
  openwop workspaces create --name <n> [--json]
  openwop workspaces switch <workspaceId> [--json]
  openwop workspaces migrate-anon [--session-file <path>] [--cookie-name <n>] [--json]

Your B2B workspaces (each a tenant, ADR 0015). \`switch\` changes the active workspace.
Distinct from \`workspace\` (singular) — the per-tenant agent FILE store.

\`migrate-anon\` → POST /v1/host/openwop-app/migrate-tenant: move an anonymous demo
session's runs, workflows, notifications and secrets into your signed-in account. It needs
BOTH a signed-in OIDC bearer (--api-key <id-token>) AND the anonymous session's cookie
value, which is read from --session-file or a no-echo prompt (never argv) and sent only as
a Cookie header (default name __session). With no valid anonymous cookie the host answers
"migrated: false" and nothing moves.

Exit codes: 0 ok · 2 usage · 4 not signed in with an OIDC bearer.`;

export async function runWorkspaces(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, WORKSPACES_HELP); return 0; }
  const args = argv.slice(['list', 'create', 'switch', 'migrate-anon'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--name', '--session-file', '--cookie-name'] });
  if (options.help) { write(ctx.io.stdout, WORKSPACES_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, '/v1/host/openwop-app/me/workspaces');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.workspaces) ? res.body.workspaces : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No workspaces.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((w: any) => ({ id: w.id ?? w.workspaceId ?? '', name: w.name ?? '', active: w.active ? 'yes' : '' })), ['id', 'name', 'active']));
      return 0;
    }
    case 'create': {
      if (!options.name) { write(ctx.io.stderr, 'Usage: openwop workspaces create --name <n> [--json]\n'); return 2; }
      const res = await requestJson(ctx, '/v1/host/openwop-app/workspaces', { method: 'POST', body: { name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created workspace ${res.body?.id ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'switch': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop workspaces switch <workspaceId> [--json]\n'); return 2; }
      const res = await requestJson(ctx, `/v1/host/openwop-app/workspaces/${encodeURIComponent(positionals[0])}/switch`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Switched to workspace ${positionals[0]}.`);
      return 0;
    }
    case 'migrate-anon': {
      const cookie = await readSecretInput(ctx, options.sessionFile !== undefined ? { valueFile: options.sessionFile } : {}, 'Anonymous session cookie value');
      const name = String(options.cookieName ?? '__session');
      const res = await gatedRequest(ctx, '/v1/host/openwop-app/migrate-tenant', { method: 'POST', body: {}, headers: { cookie: `${name}=${cookie}` } },
        'Migrating an anonymous session', 'signed-in');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const b = res.body ?? {};
      if (!b.migrated) { writeLine(ctx.io.stdout, 'Nothing migrated (no valid anonymous session cookie was presented).'); return 0; }
      writeLine(ctx.io.stdout, `Migrated: runs=${b.runs ?? 0} workflows=${b.workflows ?? 0} notifications=${b.notifications ?? 0} secrets=${b.secrets ?? 0}${b.secretsFailed ? ` (secretsFailed=${b.secretsFailed})` : ''}`);
      return 0;
    }
    default: throw new CliError(`Unknown workspaces command: ${sub}\nRun \`openwop workspaces --help\` for usage.`);
  }
}
