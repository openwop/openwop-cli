import type { Ctx } from '../context.js';
/** `openwop mcp ...` — MCP client over the host's JSON-RPC server mount (RFC 0020). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const MCP_ENDPOINT = '/v1/host/sample/mcp';

export const MCP_HELP = `Usage:
  openwop mcp ping
  openwop mcp info [--json]
  openwop mcp tools [list] [--json]
  openwop mcp tools call <name> [--args-json '{...}'] [--json]
  openwop mcp resources [list] [--json]
  openwop mcp resources templates [--json]
  openwop mcp resources read <uri> [--json]
  openwop mcp prompts [list] [--json]
  openwop mcp prompts get <name> [--args-json '{...}'] [--json]

MCP client for the host's JSON-RPC server mount (RFC 0020): a single JSON-RPC 2.0
endpoint at POST ${MCP_ENDPOINT} speaking modelcontextprotocol.io 2025-06-18.
The mount is HOST-CONTROLLED — it is env-gated (OPENWOP_MCP_SERVER_ENABLED) and OFF by
default; the CLI cannot toggle it. When the mount is not exposed the endpoint 404s and
these commands FAIL CLOSED legibly (exit 2) rather than guessing a surface.

  info            'initialize' — server name/version, protocol version, advertised capabilities.
  ping            'ping' — liveness probe of the mount (exit 0 if reachable).
  tools list      'tools/list' — workflows exposed as MCP tools (name + inputSchema).
  tools call      'tools/call' — invoke one exposed tool; exits 1 if the tool result isError.
  resources list  'resources/list' — exposed resources (uri/name/mimeType).
  resources templates  'resources/templates/list' — exposed URI templates.
  resources read  'resources/read' — read one resource's contents by uri.
  prompts list    'prompts/list' — exposed prompt templates.
  prompts get     'prompts/get' — fetch one prompt's rendered messages.

  --args-json J   (tools call / prompts get) JSON object passed as the call arguments.
  --json          Emit the raw JSON-RPC result for any read.

Exit codes: 0 ok · 1 host/tool error · 2 usage error / mount not available / invalid params.

Examples:
  openwop mcp ping
  openwop mcp info --json
  openwop mcp tools list
  openwop mcp tools call sample.demo.uppercase --args-json '{"text":"hi"}'
  openwop mcp resources read mcp://sample/readme
  openwop mcp prompts get greet --args-json '{"name":"Ada"}' --json
`;

// Map JSON-RPC error codes to CLI exit codes: contract/usage errors → 2, else host → 1.
function rpcExit(code: number): number {
  return code === -32600 || code === -32601 || code === -32602 || code === -32700 ? 2 : 1;
}

/**
 * One JSON-RPC round-trip against the mount. The mount is JSON-RPC over HTTP POST, so a
 * reachability probe IS the request: a 404 means the mount isn't exposed (env-gated off /
 * not advertised) — fail closed legibly instead of leaking a bare HTTP 404. A well-formed
 * JSON-RPC error (HTTP 200 + {error}) is surfaced as a CliError with the host's own message.
 */
async function mcpRpc(ctx: Ctx, method: string, params?: Record<string, unknown>): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method };
  if (params !== undefined) body.params = params;
  let res;
  try {
    res = await requestJson(ctx, MCP_ENDPOINT, { method: 'POST', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(
        'MCP server mount not available at this host (OPENWOP_MCP_SERVER_ENABLED off / not advertised). Failing closed.',
        2,
      );
    }
    throw err;
  }
  const rpc = res.body ?? {};
  if (rpc && typeof rpc === 'object' && rpc.error) {
    const { code, message } = rpc.error;
    throw new CliError(`MCP error ${code}: ${message ?? 'unknown'}`, rpcExit(Number(code)));
  }
  return rpc.result ?? {};
}

export async function runMcp(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'info';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  switch (sub) {
    case 'ping':
      return await runPing(ctx, argv.slice(1));
    case 'info':
    case 'initialize':
      return await runInfo(ctx, argv.slice(1));
    case 'tools':
      return await runTools(ctx, argv.slice(1));
    case 'resources':
      return await runResources(ctx, argv.slice(1));
    case 'prompts':
      return await runPrompts(ctx, argv.slice(1));
    default:
      throw new CliError(`Unknown mcp command: ${sub}\nRun \`openwop mcp --help\` for usage.`);
  }
}

async function runPing(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  await mcpRpc(ctx, 'ping');
  if (ctx.json) {
    writeJson(ctx.io.stdout, { ok: true });
    return 0;
  }
  writeLine(ctx.io.stdout, 'MCP mount reachable (ping ok).');
  return 0;
}

async function runInfo(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  const result = await mcpRpc(ctx, 'initialize');
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  writeLine(ctx.io.stdout, `server: ${result.serverInfo?.name ?? '(unknown)'} ${result.serverInfo?.version ?? ''}`.trimEnd());
  writeLine(ctx.io.stdout, `protocolVersion: ${result.protocolVersion ?? '(unknown)'}`);
  const caps = result.capabilities && typeof result.capabilities === 'object' ? Object.keys(result.capabilities) : [];
  writeLine(ctx.io.stdout, `capabilities: ${caps.length ? caps.join(', ') : '(none)'}`);
  return 0;
}

async function runTools(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'call' ? 'call' : 'list';
  const rest = argv[0] === 'list' || argv[0] === 'call' ? argv.slice(1) : argv;
  if (action === 'call') return await runToolsCall(ctx, rest);

  const { options } = parseOptions(rest, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  const result = await mcpRpc(ctx, 'tools/list');
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  const tools = Array.isArray(result.tools) ? result.tools : [];
  if (tools.length === 0) {
    writeLine(ctx.io.stdout, 'No tools exposed by the MCP mount.');
    return 0;
  }
  const rows = tools.map((t: any) => ({ name: t.name, description: t.description ?? '' }));
  writeLine(ctx.io.stdout, formatTable(rows, ['name', 'description']));
  return 0;
}

async function runToolsCall(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--args-json'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, "Usage: openwop mcp tools call <name> [--args-json '{...}'] [--json]\n");
    return options.help ? 0 : 2;
  }
  const params: Record<string, unknown> = { name: positionals[0] };
  if (options.argsJson !== undefined) {
    try {
      params.arguments = JSON.parse(options.argsJson);
    } catch {
      throw new CliError('--args-json must be valid JSON', 2);
    }
  }
  const result = await mcpRpc(ctx, 'tools/call', params);
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return result.isError ? 1 : 0;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const c of content) {
    if (c && c.type === 'text') writeLine(ctx.io.stdout, String(c.text ?? ''));
  }
  // A tool that returns isError surfaces a non-zero exit so scripts can branch.
  return result.isError ? 1 : 0;
}

async function runResources(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'templates' ? 'templates' : argv[0] === 'read' ? 'read' : 'list';
  const rest = ['list', 'templates', 'read'].includes(argv[0]) ? argv.slice(1) : argv;
  if (action === 'read') return await runResourcesRead(ctx, rest);

  const { options } = parseOptions(rest, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  const method = action === 'templates' ? 'resources/templates/list' : 'resources/list';
  const result = await mcpRpc(ctx, method);
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  if (action === 'templates') {
    const templates = Array.isArray(result.resourceTemplates) ? result.resourceTemplates : [];
    if (templates.length === 0) {
      writeLine(ctx.io.stdout, 'No resource templates exposed by the MCP mount.');
      return 0;
    }
    const rows = templates.map((r: any) => ({ uriTemplate: r.uriTemplate, name: r.name ?? '', mimeType: r.mimeType ?? '' }));
    writeLine(ctx.io.stdout, formatTable(rows, ['uriTemplate', 'name', 'mimeType']));
    return 0;
  }
  const resources = Array.isArray(result.resources) ? result.resources : [];
  if (resources.length === 0) {
    writeLine(ctx.io.stdout, 'No resources exposed by the MCP mount.');
    return 0;
  }
  const rows = resources.map((r: any) => ({ uri: r.uri, name: r.name ?? '', mimeType: r.mimeType ?? '' }));
  writeLine(ctx.io.stdout, formatTable(rows, ['uri', 'name', 'mimeType']));
  return 0;
}

async function runResourcesRead(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop mcp resources read <uri> [--json]\n');
    return options.help ? 0 : 2;
  }
  const result = await mcpRpc(ctx, 'resources/read', { uri: positionals[0] });
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  const contents = Array.isArray(result.contents) ? result.contents : [];
  for (const c of contents) {
    if (c && typeof c.text === 'string') writeLine(ctx.io.stdout, c.text);
  }
  return 0;
}

async function runPrompts(ctx: Ctx, argv: string[]) {
  const action = argv[0] === 'get' ? 'get' : 'list';
  const rest = argv[0] === 'list' || argv[0] === 'get' ? argv.slice(1) : argv;
  if (action === 'get') return await runPromptsGet(ctx, rest);

  const { options } = parseOptions(rest, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, MCP_HELP);
    return 0;
  }
  const result = await mcpRpc(ctx, 'prompts/list');
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  const prompts = Array.isArray(result.prompts) ? result.prompts : [];
  if (prompts.length === 0) {
    writeLine(ctx.io.stdout, 'No prompts exposed by the MCP mount.');
    return 0;
  }
  const rows = prompts.map((p: any) => ({
    name: p.name,
    description: p.description ?? '',
    args: Array.isArray(p.arguments) ? String(p.arguments.length) : '0',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['name', 'description', 'args']));
  return 0;
}

async function runPromptsGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--args-json'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, "Usage: openwop mcp prompts get <name> [--args-json '{...}'] [--json]\n");
    return options.help ? 0 : 2;
  }
  const params: Record<string, unknown> = { name: positionals[0] };
  if (options.argsJson !== undefined) {
    try {
      params.arguments = JSON.parse(options.argsJson);
    } catch {
      throw new CliError('--args-json must be valid JSON', 2);
    }
  }
  const result = await mcpRpc(ctx, 'prompts/get', params);
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return 0;
  }
  if (result.description) writeLine(ctx.io.stdout, `description: ${result.description}`);
  const messages = Array.isArray(result.messages) ? result.messages : [];
  for (const m of messages) {
    const text = m?.content?.type === 'text' ? m.content.text : typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content);
    writeLine(ctx.io.stdout, `[${m?.role ?? '?'}] ${text ?? ''}`);
  }
  return 0;
}
