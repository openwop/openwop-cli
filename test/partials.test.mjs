// Batch-2 partial-group completions: runs fork/diff/delete/bulk-cancel, prompts
// create/delete, byok ai-default, governance media-budget, catalog tools.
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

describe('runs partials', () => {
  it('fork posts to {id}:fork with mode/fromSeq', async () => {
    const cap = capture(); let seen;
    await runCli(['runs', 'fork', 'r1', '--mode', 'branch', '--from-sequence', '3', '--json'], base(cap, async (url, init) => {
      seen = { path: new URL(url).pathname, method: init?.method, body: JSON.parse(init.body) };
      return json({ runId: 'r2' });
    }));
    assert.match(seen.path, /\/v1\/runs\/r1:fork$/);
    assert.equal(seen.method, 'POST');
    assert.deepEqual(seen.body, { mode: 'branch', fromSeq: 3 });
  });
  it('diff GETs {id}:diff?against', async () => {
    const cap = capture(); let url2;
    await runCli(['runs', 'diff', 'r1', '--against', 'r2'], base(cap, async (url) => { url2 = new URL(url); return json({ changed: [] }); }));
    assert.match(url2.pathname, /\/v1\/runs\/r1:diff$/);
    assert.equal(url2.searchParams.get('against'), 'r2');
  });
  it('delete refuses without --yes, deletes with it', async () => {
    const cap = capture();
    assert.equal(await runCli(['runs', 'delete', 'r1'], base(cap, async () => json({}))), 2);
    const cap2 = capture(); let m;
    await runCli(['runs', 'delete', 'r1', '--yes'], base(cap2, async (url, init) => { m = init?.method; return json({}); }));
    assert.equal(m, 'DELETE');
  });
  it('bulk-cancel posts runIds', async () => {
    const cap = capture(); let body;
    await runCli(['runs', 'bulk-cancel', 'a', 'b', '--reason', 'stop'], base(cap, async (url, init) => {
      assert.match(new URL(url).pathname, /\/v1\/runs:bulk-cancel$/); body = JSON.parse(init.body); return json({ cancelled: 2 });
    }));
    assert.deepEqual(body, { runIds: ['a', 'b'], reason: 'stop' });
  });
});

describe('prompts + byok + governance + catalog partials', () => {
  it('prompts create posts a PromptTemplate', async () => {
    const cap = capture(); let body, method, path;
    await runCli(['prompts', 'create', '--template-id', 't1', '--version', '1.0.0', '--kind', 'system', '--text', 'hi'], base(cap, async (url, init) => {
      path = new URL(url).pathname; method = init?.method; body = JSON.parse(init.body); return json({ templateId: 't1' });
    }));
    assert.match(path, /\/v1\/prompts$/); assert.equal(method, 'POST');
    assert.deepEqual(body, { templateId: 't1', version: '1.0.0', kind: 'system', text: 'hi' });
  });
  it('byok ai-default set PUTs credentialRef', async () => {
    const cap = capture(); let body, method, path;
    await runCli(['byok', 'ai-default', 'set', 'anthropic-prod'], base(cap, async (url, init) => {
      path = new URL(url).pathname; method = init?.method; body = JSON.parse(init.body); return json({ credentialRef: 'anthropic-prod' });
    }));
    assert.match(path, /\/v1\/host\/sample\/byok\/ai-default$/); assert.equal(method, 'PUT');
    assert.deepEqual(body, { credentialRef: 'anthropic-prod' });
  });
  it('governance media-budget set PUTs numeric caps', async () => {
    const cap = capture(); let body, path;
    await runCli(['governance', 'media-budget', 'set', '--tts-chars', '5000', '--stt-bytes', '100000'], base(cap, async (url, init) => {
      path = new URL(url).pathname; body = JSON.parse(init.body); return json({ override: {} });
    }));
    assert.match(path, /\/governance\/media-budget$/);
    assert.deepEqual(body, { ttsChars: 5000, sttBytes: 100000 });
  });
  it('catalog tools GETs /v1/tools', async () => {
    const cap = capture(); let path;
    await runCli(['catalog', 'tools', '--json'], base(cap, async (url) => { path = new URL(url).pathname; return json({ tools: [] }); }));
    assert.match(path, /\/v1\/tools$/);
  });
});
