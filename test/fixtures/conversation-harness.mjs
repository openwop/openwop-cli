// Shared mock-host harness for the conversation / messaging group tests
// (chat, assistant, channels, scheduled-chats, voice, ai, a2a, notifications,
// computer-use, whatsapp, agent-author, workflow-author, workflow-proposals).
// Not a test file itself (node --test only runs test/*.test.mjs).
import { runCli } from '../../dist/cli.js';

export function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function sseResponse(frames) {
  const text = frames.map((f) => `${f.event ? `event: ${f.event}\n` : ''}data: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A recording mock host. `routes` maps `"METHOD /path"` (path without query)
 * to a response factory `(call) => Response` or a plain JSON body. Discovery
 * answers a v1 document so paths stay `/v1/host/openwop-app/...`.
 */
export function mockHost(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return jsonResponse({ protocolVersion: '1.0', capabilities: {} });
    const method = init.method ?? 'GET';
    const call = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${method} ${u.pathname}`;
    const handler = routes[key];
    if (handler === undefined) return jsonResponse({ error: 'not_found', message: `unmocked ${key}` }, 404);
    if (typeof handler === 'function') return handler(call);
    return jsonResponse(handler);
  };
  return { calls, fetchImpl };
}

export async function run(argv, host) {
  const cap = capture();
  const code = await runCli(argv, { io: cap.io, fetchImpl: host.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } });
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

export const H = '/v1/host/openwop-app';
