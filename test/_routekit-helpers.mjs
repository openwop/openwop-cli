// Shared fixtures for the route-table groups' tests (not a test file itself:
// `npm test` runs test/*.test.mjs only).
export function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

export function json(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A mock host that records every non-discovery request. `handler(req)` returns a Response. */
export function mockHost(handler = () => json({})) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/.well-known/openwop')) return json({ protocolVersion: '1.0', capabilities: {} });
    const call = { method: init.method ?? 'GET', path: u.pathname, search: u.search, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl, last: () => calls[calls.length - 1] };
}

export function opts(host, cap, env = { OPENWOP_API_KEY: 'k' }) {
  return { io: cap.io, fetchImpl: host.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env };
}
