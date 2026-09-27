// Shared mock-host helper for the identity/admin group tests. Records every request
// (method, path+query, parsed JSON body, headers) and answers from a route table.
export function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

/** routes: (call) => { status?, body?, raw?, headers? } */
export function mockHost(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      search: u.search,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const r = routes(call) ?? {};
    const status = r.status ?? 200;
    const text = r.raw !== undefined ? r.raw : r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  return { calls, fetchImpl };
}

export function opts(fetchImpl, cap, env = {}) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1', ...env } };
}

export const forbidden = { status: 403, body: { error: 'forbidden', message: 'This administration surface requires a superadmin principal.', details: { hint: 'add your tenant id to OPENWOP_SUPERADMIN_TENANTS' } } };
