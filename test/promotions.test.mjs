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
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so no discovery request is made.
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
const B = '/v1/host/openwop-app/promotions/orgs/org%2F1/promotions';

describe('promotions', () => {
  it('list renders a table from the host rows (org id URL-encoded)', async () => {
    const cap = capture();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse({ promotions: [{ promotionId: 'p1', name: 'Spend 50', type: 'cart_threshold', active: true, priority: 1 }], usage: {} });
    };
    const code = await runCli(['promotions', 'list', '--org', 'org/1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(calls[0].url.pathname, B);
    assert.equal(calls[0].init.method, 'GET');
    assert.match(cap.stdout, /p1\s+Spend 50\s+cart_threshold\s+true\s+1/);
  });

  it('list --json emits the host body verbatim; empty renders a message', async () => {
    const body = { promotions: [], usage: {} };
    let cap = capture();
    assert.equal(await runCli(['--json', 'promotions', 'list', '--org', 'o'], opts(async () => jsonResponse(body), cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
    cap = capture();
    assert.equal(await runCli(['promotions', 'list', '--org', 'o'], opts(async () => jsonResponse(body), cap)), 0);
    assert.match(cap.stdout, /No promotions/);
  });

  it('create sends typed body fields (numbers/json/bool) exactly', async () => {
    const cap = capture();
    let seen;
    const fetchImpl = async (url, init) => { seen = { url: new URL(url), init }; return jsonResponse({ promotion: { promotionId: 'p2' } }, 201); };
    const code = await runCli(['promotions', 'create', '--org', 'o', '--name', 'X', '--type', 'cart_threshold', '--min-spend', '50', '--reward', '{"kind":"percentage","value":10}', '--stackable', 'false'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.url.pathname, '/v1/host/openwop-app/promotions/orgs/o/promotions');
    assert.deepEqual(JSON.parse(seen.init.body), { name: 'X', type: 'cart_threshold', minSpend: 50, reward: { kind: 'percentage', value: 10 }, stackable: false });
  });

  it('create without the required --type is a usage error (exit 2, no request)', async () => {
    const cap = capture();
    const code = await runCli(['promotions', 'create', '--org', 'o', '--name', 'X'], opts(async () => { throw new Error('no request expected'); }, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /--type is required/);
  });

  it('delete refuses without --yes, then DELETEs', async () => {
    let cap = capture();
    assert.equal(await runCli(['promotions', 'delete', 'p1', '--org', 'o'], opts(async () => { throw new Error('no'); }, cap)), 2);
    assert.match(cap.stderr, /without --yes/);
    cap = capture();
    let seen;
    const code = await runCli(['promotions', 'delete', 'p1', '--org', 'o', '--yes'], opts(async (url, init) => { seen = { url: new URL(url), init }; return jsonResponse({ ok: true }); }, cap));
    assert.equal(code, 0);
    assert.equal(seen.init.method, 'DELETE');
    assert.equal(seen.url.pathname, `/v1/host/openwop-app/promotions/orgs/o/promotions/p1`);
  });

  it('missing --org is a legible usage error', async () => {
    const cap = capture();
    assert.equal(await runCli(['promotions', 'list'], opts(async () => { throw new Error('no'); }, cap)), 2);
    assert.match(cap.stderr, /--org/);
  });

  it('403 → legible message + exit 4', async () => {
    const cap = capture();
    const code = await runCli(['promotions', 'get', 'p1', '--org', 'o'], opts(async () => jsonResponse({ error: 'forbidden', message: 'Not permitted.' }, 403), cap));
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Not permitted\./);
  });
});
