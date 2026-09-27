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
const CB = '/v1/host/openwop-app/campaign-brief';

describe('campaign-brief command', () => {
  it('personas list/get/create/update/delete hit the persona routes', async () => {
    const cap = capture();
    const r = recorder(() => json({ personas: [{ id: 'p_1', name: 'Ops', role: 'Dir', buyerStage: 'awareness' }], persona: { id: 'p_1', name: 'Ops' } }));
    const run = (argv) => runCli(['campaign-brief', 'personas', ...argv], opts(r.fetchImpl, cap));
    assert.equal(await run(['list', '--org', 'org_1', '--brand', 'br_1']), 0);
    assert.match(cap.stdout, /p_1\s+Ops\s+Dir\s+awareness/);
    assert.equal(await run(['get', 'p_1']), 0);
    assert.equal(await run(['create', '--org', 'org_1', '--name', 'Ops', '--buyer-stage', 'awareness', '--body', '{"painPoints":["a"]}']), 0);
    assert.equal(await run(['update', 'p_1', '--role', 'VP']), 0);
    assert.equal(await run(['delete', 'p_1']), 2);
    assert.equal(await run(['delete', 'p_1', '--yes']), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      `GET ${CB}/personas?orgId=org_1&brandId=br_1`, `GET ${CB}/personas/p_1`, `POST ${CB}/personas`,
      `PATCH ${CB}/personas/p_1`, `DELETE ${CB}/personas/p_1`,
    ]);
    assert.deepEqual(r.calls[2].body, { painPoints: ['a'], name: 'Ops', buyerStage: 'awareness', orgId: 'org_1' });
    assert.deepEqual(r.calls[3].body, { role: 'VP' });
  });

  it('briefs lifecycle: list/create/update/validate/duplicate/versions/delete', async () => {
    const cap = capture();
    const r = recorder(() => json({ briefs: [], brief: { id: 'b_2' }, versions: [], valid: false, issues: [{ field: 'productName', message: 'A product is required.' }], enabledChannels: [] }));
    const run = (argv) => runCli(['campaign-brief', 'briefs', ...argv], opts(r.fetchImpl, cap));
    assert.equal(await run(['list', '--org', 'org_1']), 0);
    assert.equal(await run(['create', '--org', 'org_1', '--name', 'Q3', '--objective', 'trials', '--product-name', 'P']), 0);
    assert.equal(await run(['update', 'b_1', '--brand-id', 'br_1']), 0);
    assert.equal(await run(['validate', 'b_1']), 0);
    assert.match(cap.stdout, /valid: no/);
    assert.match(cap.stdout, /productName: A product is required\./);
    assert.equal(await run(['duplicate', 'b_1', '--name', 'Copy']), 0);
    assert.equal(await run(['versions', 'b_1']), 0);
    assert.equal(await run(['delete', 'b_1', '--yes']), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      `GET ${CB}/briefs?orgId=org_1`, `POST ${CB}/briefs`, `PATCH ${CB}/briefs/b_1`, `POST ${CB}/briefs/b_1/validate`,
      `POST ${CB}/briefs/b_1/duplicate`, `GET ${CB}/briefs/b_1/versions`, `DELETE ${CB}/briefs/b_1`,
    ]);
    assert.deepEqual(r.calls[1].body, { name: 'Q3', objective: 'trials', productName: 'P', orgId: 'org_1' });
    assert.deepEqual(r.calls[4].body, { name: 'Copy' });
  });

  it('voc/angles/targeting reads + deletes, buyer-stages, hooks + promote', async () => {
    const cap = capture();
    const r = recorder((u) => (u.pathname.endsWith('/voc') ? json({ evidence: [{ id: 'e1', sentiment: 'pain', theme: 'cost', quote: 'too pricey' }] }) : json({ buyerStages: ['awareness'], channels: ['email'], hooks: [], hook: { status: 'tested' } })));
    const run = (argv) => runCli(['campaign-brief', ...argv], opts(r.fetchImpl, cap));
    assert.equal(await run(['voc', 'b_1', '--sentiment', 'pain', '--theme', 'cost']), 0);
    assert.match(cap.stdout, /e1\s+pain\s+cost\s+too pricey/);
    assert.equal(await run(['voc-delete', 'b_1', 'e1', '--yes']), 0);
    assert.equal(await run(['angles', 'b_1']), 0);
    assert.equal(await run(['angle-delete', 'b_1', 'a1', '--yes']), 0);
    assert.equal(await run(['targeting', 'b_1']), 0);
    assert.equal(await run(['targeting-delete', 'b_1', 'meta', '--yes']), 0);
    assert.equal(await run(['buyer-stages']), 0);
    assert.match(cap.stdout, /buyerStages: awareness/);
    assert.equal(await run(['hooks', '--org', 'org_1', '--status', 'candidate']), 0);
    assert.equal(await run(['hook-promote', 'h/1', '--org', 'org_1', '--status', 'tested', '--metric-ref-json', '{"ctr":0.1}']), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      `GET ${CB}/briefs/b_1/voc?sentiment=pain&theme=cost`, `DELETE ${CB}/briefs/b_1/voc/e1`,
      `GET ${CB}/briefs/b_1/angles`, `DELETE ${CB}/briefs/b_1/angles/a1`,
      `GET ${CB}/briefs/b_1/targeting`, `DELETE ${CB}/briefs/b_1/targeting/meta`,
      `GET ${CB}/buyer-stages`, `GET ${CB}/hooks?orgId=org_1&status=candidate`, `POST ${CB}/hooks/h%2F1/promote`,
    ]);
    assert.deepEqual(r.calls.at(-1).body, { orgId: 'org_1', status: 'tested', metricRef: { ctr: 0.1 } });
  });

  it('--json prints the raw body; deletes refuse without --yes; hooks needs --org', async () => {
    const cap = capture();
    const r = recorder(() => json({ angles: [{ id: 'a1' }] }));
    assert.equal(await runCli(['campaign-brief', 'angles', 'b_1', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { angles: [{ id: 'a1' }] });
    assert.equal(await runCli(['campaign-brief', 'voc-delete', 'b_1', 'e1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['campaign-brief', 'hooks'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 1);
  });

  it('a 403 is a legible message with exit 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(await runCli(['campaign-brief', 'briefs', 'create', '--org', 'org_1', '--name', 'X'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: Missing required scope/);
  });
});
