import type { Ctx } from '../context.js';
/**
 * `openwop dev ...` — developer/demo-only host seams. Today: the reference UCP
 * merchant's MCP endpoint (a JSON-RPC `tools/call` for ucp.discover / ucp.search
 * / ucp.checkout). The route exists ONLY when the host runs with
 * OPENWOP_UCP_REF_MERCHANT_ENABLED=true — a 404 elsewhere is expected. A checkout
 * creates a pending, unpaid demo order.
 */
import { write } from '../io.js';
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const MCP = '/v1/host/openwop-app/dev/ucp-merchant/mcp';

export const DEV_ROUTES: RouteCmd[] = [
  { words: ['ucp-merchant', 'call'], method: 'POST', path: MCP, fixed: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    summary: 'JSON-RPC tools/call against the reference merchant: --tool ucp.discover | ucp.search | ucp.checkout, --arguments <json>.',
    body: [{ flag: '--tool', key: 'params.name', required: true }, { flag: '--arguments', key: 'params.arguments', type: 'json' }, { flag: '--id', key: 'id', type: 'number' }] },
];

export const DEV_HELP = `Usage:
${routesHelp('dev', DEV_ROUTES)}
Developer/demo seams (not for production hosts). The CLI fills in the JSON-RPC
envelope ({jsonrpc:"2.0", method:"tools/call"}); the host always answers 200 with
a JSON-RPC result or error.

Examples:
  openwop dev ucp-merchant call --tool ucp.discover
  openwop dev ucp-merchant call --tool ucp.search --arguments '{"q":"mug"}'
  openwop dev ucp-merchant call --tool ucp.checkout --arguments '{"lines":[{"productId":"p1","quantity":2}]}'
`;

export async function runDev(ctx: Ctx, argv: string[]) {
  if (argv.length === 1 && argv[0] === 'ucp-merchant') { write(ctx.io.stdout, DEV_HELP); return 0; }
  return runRouteGroup(ctx, 'dev', DEV_HELP, DEV_ROUTES, argv);
}
