// Batch-2b partial completions: kanban assign/claim/personal/assigned, workflows
// chains/from-chain/chain-pack, triggers update/ingest.
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

describe('kanban partials', () => {
  it('card-assign posts assigneeId', async () => {
    const cap = capture(); let seen;
    await runCli(['kanban', 'card-assign', 'c1', '--assignee', 'user:x', '--role', 'reviewer'], base(cap, async (url, init) => {
      seen = { path: new URL(url).pathname, method: init?.method, body: JSON.parse(init.body) }; return json({ ok: true });
    }));
    assert.match(seen.path, /\/kanban\/cards\/c1\/assign$/); assert.equal(seen.method, 'POST');
    assert.deepEqual(seen.body, { assigneeId: 'user:x', assigneeRole: 'reviewer' });
  });
  it('card-claim posts to /claim', async () => {
    const cap = capture(); let path, method;
    await runCli(['kanban', 'card-claim', 'c1'], base(cap, async (url, init) => { path = new URL(url).pathname; method = init?.method; return json({ ok: true }); }));
    assert.match(path, /\/kanban\/cards\/c1\/claim$/); assert.equal(method, 'POST');
  });
  it('assigned GETs /kanban/assigned', async () => {
    const cap = capture(); let path;
    await runCli(['kanban', 'assigned', '--json'], base(cap, async (url) => { path = new URL(url).pathname; return json({ cards: [] }); }));
    assert.match(path, /\/kanban\/assigned$/);
  });
});

describe('workflows partials', () => {
  it('chains GETs /workflow-chains', async () => {
    const cap = capture(); let path;
    await runCli(['workflows', 'chains', '--json'], base(cap, async (url) => { path = new URL(url).pathname; return json({ chains: [] }); }));
    assert.match(path, /\/workflow-chains$/);
  });
  it('from-chain posts chainId + params', async () => {
    const cap = capture(); let body, path;
    await runCli(['workflows', 'from-chain', 'ch1', '--params-json', '{"a":1}'], base(cap, async (url, init) => {
      path = new URL(url).pathname; body = JSON.parse(init.body); return json({ workflowId: 'wf1' });
    }));
    assert.match(path, /\/workflows\/from-chain$/);
    assert.deepEqual(body, { chainId: 'ch1', params: { a: 1 } });
  });
});

describe('triggers partials', () => {
  it('update PATCHes state', async () => {
    const cap = capture(); let seen;
    await runCli(['triggers', 'update', 's1', '--state', 'paused'], base(cap, async (url, init) => {
      seen = { path: new URL(url).pathname, method: init?.method, body: JSON.parse(init.body) }; return json({ state: 'paused' });
    }));
    assert.match(seen.path, /\/v1\/trigger-subscriptions\/s1$/); assert.equal(seen.method, 'PATCH');
    assert.deepEqual(seen.body, { state: 'paused' });
  });
  it('ingest posts the event body', async () => {
    const cap = capture(); let seen;
    await runCli(['triggers', 'ingest', 's1', '--event-json', '{"hello":"world"}'], base(cap, async (url, init) => {
      seen = { path: new URL(url).pathname, method: init?.method, body: JSON.parse(init.body) }; return json({ accepted: true });
    }));
    assert.match(seen.path, /\/v1\/trigger-subscriptions\/s1\/ingest$/); assert.equal(seen.method, 'POST');
    assert.deepEqual(seen.body, { hello: 'world' });
  });
});
