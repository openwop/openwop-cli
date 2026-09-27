import type { Ctx } from '../context.js';
/**
 * `openwop compat-endpoints ...` — self-hosted / OpenAI-compatible model
 * endpoints an org configures (RFC 0108 + openwop-app ADR 0121).
 *
 * Host-extension surface (non-normative):
 *   GET    /v1/host/openwop-app/compat-endpoints?orgId=…   (workspace:read)
 *   POST   /v1/host/openwop-app/compat-endpoints           (workspace:write)
 *   DELETE /v1/host/openwop-app/compat-endpoints/{id}      (workspace:write)
 *
 * The whole surface 404s unless the operator opts in
 * (OPENWOP_COMPAT_PROVIDER_ENABLED=true on the server). Secrets are refs: the
 * endpoint's API key is sent once on create, stored host-side (BYOK), and never
 * returned — reads report only `hasKey`.
 */
import { readFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { failClosedOn404 } from './requestHelpers.js';

const BASE = '/v1/host/openwop-app/compat-endpoints';

export const COMPAT_ENDPOINTS_HELP = `Usage:
  openwop compat-endpoints list --org <orgId> [--json]
  openwop compat-endpoints create --org <orgId> --label <l> --base-url-endpoint <https://…> [--api-key-file <path> | --api-key-env <VAR>] [--model <m>]... [--vision] [--tools] [--long-context] [--json]
  openwop compat-endpoints delete <endpointId> [--yes]

Self-hosted / OpenAI-compatible model endpoints for an org (RFC 0108, ADR 0121).

  list    GET    /v1/host/openwop-app/compat-endpoints?orgId=…
  create  POST   /v1/host/openwop-app/compat-endpoints   { orgId, label, baseUrl, apiKey?, models?, capabilities }
  delete  DELETE /v1/host/openwop-app/compat-endpoints/{id}   (also removes the stored key)

The server must opt in (OPENWOP_COMPAT_PROVIDER_ENABLED=true); otherwise every
command exits 1 with the host's "disabled" message. The endpoint URL must be
https and public unless the server allows private egress.

Secrets never travel on the command line: pass the endpoint key with
--api-key-file <path> or --api-key-env <VAR>. It is sent once, stored by the
server, and never shown again (reads report only hasKey).

  --base-url-endpoint <url>  The endpoint's base URL (distinct from the global --base-url).
  --model <m>                A model the endpoint serves (repeatable).
  --vision / --tools / --long-context   Declared capabilities of the endpoint.

Exit codes: 0 ok · 1 surface disabled / not found · 2 usage · 4 missing scope.

Examples:
  openwop compat-endpoints list --org org_1
  openwop compat-endpoints create --org org_1 --label "vLLM" --base-url-endpoint https://llm.example.com/v1 --api-key-env VLLM_KEY --model llama-3
  openwop compat-endpoints delete compat-123 --yes
`;

export async function runCompatEndpoints(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, COMPAT_ENDPOINTS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(['list', 'create', 'delete'].includes(sub) ? 1 : 0), {
    bool: ['--help', '--yes', '--vision', '--tools', '--long-context'],
    value: ['--org', '--label', '--base-url-endpoint', '--api-key-file', '--api-key-env'],
    multi: ['--model'],
  });
  if (options.help) { write(ctx.io.stdout, COMPAT_ENDPOINTS_HELP); return 0; }
  try {
    switch (sub) {
      case 'list': {
        const org = requireOrg(options.org);
        const res = await requestJson(ctx, `${BASE}?orgId=${encodeURIComponent(org)}`);
        if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
        const items = Array.isArray(res.body?.endpoints) ? res.body.endpoints : [];
        if (items.length === 0) { writeLine(ctx.io.stdout, `No compat endpoints configured for org ${org}.`); return 0; }
        writeLine(ctx.io.stdout, formatTable(items.map((e: any) => ({
          id: e.id,
          label: e.label ?? '',
          baseUrl: e.baseUrl ?? '',
          hasKey: e.hasKey ? 'yes' : 'no',
          models: Array.isArray(e.models) ? e.models.join(',') : '',
        })), ['id', 'label', 'baseUrl', 'hasKey', 'models']));
        return 0;
      }
      case 'create': {
        const org = requireOrg(options.org);
        if (!options.label || !options.baseUrlEndpoint) {
          throw new CliError('create needs --label <l> and --base-url-endpoint <url>.', 2);
        }
        const body: Record<string, unknown> = {
          orgId: org,
          label: options.label,
          baseUrl: options.baseUrlEndpoint,
          capabilities: { vision: Boolean(options.vision), tools: Boolean(options.tools), longContext: Boolean(options.longContext) },
        };
        const apiKey = readApiKey(ctx, options);
        if (apiKey) body.apiKey = apiKey;
        if (Array.isArray(options.model) && options.model.length) body.models = options.model;
        const res = await requestJson(ctx, BASE, { method: 'POST', body });
        if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
        writeLine(ctx.io.stdout, `Created compat endpoint ${res.body?.id ?? ''} (${res.body?.label ?? options.label}); key stored: ${res.body?.hasKey ? 'yes' : 'no'}.`);
        return 0;
      }
      case 'delete': {
        if (positionals.length !== 1) throw new CliError('Usage: openwop compat-endpoints delete <endpointId> [--yes]', 2);
        if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete ${positionals[0]} (and its stored key) without --yes.`); return 2; }
        await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
        writeLine(ctx.io.stdout, `Deleted compat endpoint ${positionals[0]}.`);
        return 0;
      }
      default:
        throw new CliError(`Unknown compat-endpoints command: ${sub}\nRun \`openwop compat-endpoints --help\` for usage.`);
    }
  } catch (err) {
    failClosedOn404(err, 'compat-endpoints');
  }
}

/** The endpoint key from a file or an env var — never from argv (it would land in shell history). */
function readApiKey(ctx: Ctx, options: Record<string, any>): string | undefined {
  if (options.apiKeyFile && options.apiKeyEnv) throw new CliError('Pass only one of --api-key-file / --api-key-env.', 2);
  if (options.apiKeyFile) {
    try {
      return readFileSync(String(options.apiKeyFile), 'utf8').trim() || undefined;
    } catch (err) {
      throw new CliError(`Could not read ${options.apiKeyFile}: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  }
  if (options.apiKeyEnv) {
    const v = ctx.env[String(options.apiKeyEnv)];
    if (!v) throw new CliError(`Environment variable ${options.apiKeyEnv} is empty or unset.`, 2);
    return v.trim();
  }
  return undefined;
}
