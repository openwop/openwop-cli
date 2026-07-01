// Batch-3a flagship groups: crm + csm (flat CRUD).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';

function capture() {
  let stdout = '', stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; }, get stderr() { return stderr; },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = (cap, fetchImpl) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test', OPENWOP_API_KEY: 'k' } });

describe('crm group', () => {
  it('list GETs /crm/contacts and tables the rows', async () => {
    const cap = capture(); let path;
    await runCli(['crm', 'list'], base(cap, async (url) => { path = new URL(url).pathname; return json({ contacts: [{ id: 'c1', name: 'Ann', stage: 'lead' }] }); }));
    assert.match(path, /\/crm\/contacts$/);
    assert.match(cap.stdout, /c1\s+Ann\s+lead/);
  });
  it('create POSTs required name + optional fields', async () => {
    const cap = capture(); let seen;
    await runCli(['crm', 'create', '--name', 'Ann', '--email', 'a@x.io', '--stage', 'lead'], base(cap, async (url, init) => {
      seen = { method: init?.method, body: JSON.parse(init.body) }; return json({ id: 'c1' });
    }));
    assert.equal(seen.method, 'POST');
    assert.deepEqual(seen.body, { name: 'Ann', email: 'a@x.io', stage: 'lead' });
  });
  it('create without --name is a usage error (exit 2)', async () => {
    const cap = capture();
    assert.equal(await runCli(['crm', 'create'], base(cap, async () => json({}))), 2);
  });
  it('delete refuses without --yes, PATCHes/DELETEs otherwise', async () => {
    const cap = capture();
    assert.equal(await runCli(['crm', 'delete', 'c1'], base(cap, async () => json({}))), 2);
    const cap2 = capture(); let m;
    await runCli(['crm', 'delete', 'c1', '--yes'], base(cap2, async (url, init) => { m = init?.method; return json({}); }));
    assert.equal(m, 'DELETE');
  });
  it('triage POSTs to /{id}/triage', async () => {
    const cap = capture(); let path, m;
    await runCli(['crm', 'triage', 'c1'], base(cap, async (url, init) => { path = new URL(url).pathname; m = init?.method; return json({ runId: 'r1' }); }));
    assert.match(path, /\/crm\/contacts\/c1\/triage$/); assert.equal(m, 'POST');
  });
});

describe('csm group', () => {
  it('create POSTs name + numeric healthScore', async () => {
    const cap = capture(); let body, path;
    await runCli(['csm', 'create', '--name', 'Acme', '--health-score', '80'], base(cap, async (url, init) => {
      path = new URL(url).pathname; body = JSON.parse(init.body); return json({ id: 'a1' });
    }));
    assert.match(path, /\/csm\/accounts$/);
    assert.deepEqual(body, { name: 'Acme', healthScore: 80 });
  });
  it('update PATCHes /{id}', async () => {
    const cap = capture(); let path, m;
    await runCli(['csm', 'update', 'a1', '--name', 'Acme Inc'], base(cap, async (url, init) => { path = new URL(url).pathname; m = init?.method; return json({ id: 'a1' }); }));
    assert.match(path, /\/csm\/accounts\/a1$/); assert.equal(m, 'PATCH');
  });
});
