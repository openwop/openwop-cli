// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so the mock sees the literal /v1/host/openwop-app paths (no discovery fetch).
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });

/** A fetch mock that records every call and answers from `reply(url, init)`. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}

const F = '/v1/host/openwop-app/funnels/orgs/org_1/funnels';

describe('funnels command', () => {
  it('list renders a table from GET …/funnels', async () => {
    const cap = capture();
    const r = recorder(() => json({ funnels: [{ funnelId: 'fn_1', name: 'Webinar', slug: 'webinar', status: 'draft', steps: [{}, {}] }] }));
    const code = await runCli(['funnels', 'list', '--org', 'org_1'], opts(r.fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`GET ${F}`]);
    assert.match(cap.stdout, /fn_1\s+Webinar\s+webinar\s+draft\s+2/);
  });

  it('list --json prints the raw host body', async () => {
    const cap = capture();
    const r = recorder(() => json({ funnels: [] }));
    const code = await runCli(['funnels', 'list', '--org', 'org_1', '--json'], opts(r.fetchImpl, cap));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(cap.stdout), { funnels: [] });
  });

  it('create POSTs name/slug/steps (flags win over --body)', async () => {
    const cap = capture();
    const r = recorder(() => json({ funnel: { funnelId: 'fn_9', status: 'draft' } }, 201));
    const code = await runCli(['funnels', 'create', '--org', 'org_1', '--name', 'N', '--slug', 's', '--steps-json', '[{"kind":"page"}]', '--body', '{"name":"ignored","extra":1}'], opts(r.fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].path, F);
    assert.deepEqual(r.calls[0].body, { name: 'N', slug: 's', steps: [{ kind: 'page' }], extra: 1 });
    assert.match(cap.stdout, /Created funnel fn_9/);
  });

  it('update PATCHes only the passed fields; publish/archive POST the lifecycle verb', async () => {
    const cap = capture();
    const r = recorder(() => json({ funnel: { funnelId: 'fn/1' } }));
    assert.equal(await runCli(['funnels', 'update', 'fn/1', '--org', 'org_1', '--name', 'X'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'publish', 'fn/1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'archive', 'fn/1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'unpublish', 'fn/1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [
      `PATCH ${F}/fn%2F1`, `POST ${F}/fn%2F1/publish`, `POST ${F}/fn%2F1/archive`, `POST ${F}/fn%2F1/unpublish`,
    ]);
    assert.deepEqual(r.calls[0].body, { name: 'X' });
  });

  it('delete refuses without --yes (no request) and DELETEs with it', async () => {
    const cap = capture();
    const r = recorder(() => json({ ok: true }));
    assert.equal(await runCli(['funnels', 'delete', 'fn_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['funnels', 'delete', 'fn_1', '--org', 'org_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`DELETE ${F}/fn_1`]);
  });

  it('stats, stats-rebuild and the experiment family hit their paths', async () => {
    const cap = capture();
    const r = recorder(() => json({ steps: [{ stepId: 's1', kind: 'page', views: 10, completions: 5, conversion: 0.5 }], funnel: {}, rows: 3 }));
    assert.equal(await runCli(['funnels', 'stats', 'fn_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.match(cap.stdout, /s1\s+page\s+10\s+5\s+0\.5/);
    assert.equal(await runCli(['funnels', 'stats-rebuild', 'fn_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'experiment-set', 'fn_1', 's1', '--org', 'org_1', '--variants-json', '[{"id":"a"},{"id":"b"}]'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'experiment-results', 'fn_1', 's1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'experiment-stop', 'fn_1', 's1', '--org', 'org_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [
      `GET ${F}/fn_1/stats`, `POST ${F}/fn_1/stats/rebuild`, `POST ${F}/fn_1/steps/s1/experiment`,
      `GET ${F}/fn_1/steps/s1/experiment/results`, `DELETE ${F}/fn_1/steps/s1/experiment`,
    ]);
    assert.deepEqual(r.calls[2].body, { variants: [{ id: 'a' }, { id: 'b' }] });
  });

  it('public view/step/next hit the anonymous surface without a bearer', async () => {
    const cap = capture();
    const r = recorder(() => json({ funnel: { slug: 'w', name: 'W' }, stepCount: 2, step: { ix: 0, stepId: 's1', kind: 'page' } }));
    assert.equal(await runCli(['funnels', 'public', 'view', 'org_1', 'w', '--vk', 'v1', '--utm', 'source=x'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'public', 'step', 'org_1', 'w', '1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['funnels', 'public', 'next', 'org_1', 'w', '--from', 's1', '--outcome', 'accepted'], opts(r.fetchImpl, cap)), 0);
    const P = '/v1/host/openwop-app/public/org_1/funnels/w';
    assert.deepEqual(r.calls.map((c) => `${c.path}${c.search}`), [`${P}?vk=v1&utm_source=x`, `${P}/steps/1`, `${P}/next?from=s1&outcome=accepted`]);
    assert.ok(r.calls.every((c) => !c.headers.authorization));
    assert.match(cap.stdout, /step: 0 s1 \(page\)/);
  });

  it('a 403 is a legible message with exit 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }, 403));
    const code = await runCli(['funnels', 'publish', 'fn_1', '--org', 'org_1'], opts(r.fetchImpl, cap));
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: Missing required scope/);
  });

  it('usage errors: missing --org and missing --name exit 2 without a request', async () => {
    const cap = capture();
    const r = recorder(() => json({}));
    assert.equal(await runCli(['funnels', 'list'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['funnels', 'create', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
  });
});
