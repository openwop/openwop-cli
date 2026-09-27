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

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fake v1 host: `/.well-known/openwop` advertises protocol 1.x (so paths are
 * sent exactly as written); every other request is recorded and answered by
 * `handler(method, path, body, url)`.
 */
function fakeHost(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return json({ protocolVersions: ['1.1'] });
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} });
    return handler(method, u.pathname, body, u);
  };
  return { fetchImpl, calls };
}

async function run(argv, handler, env = {}) {
  const cap = capture();
  const { fetchImpl, calls } = fakeHost(handler);
  const code = await runCli(argv, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', ...env } });
  return { code, stdout: cap.stdout, stderr: cap.stderr, calls };
}

const forbidden = () => json({ error: 'forbidden', message: 'Missing required scope' }, 403);

const KB = '/v1/host/openwop-app/agents/a1/knowledge';

describe('agent-knowledge (ADR 0038)', () => {
  it('show renders collections', async () => {
    const r = await run(['agent-knowledge', 'show', 'a1'], () => json({
      agentId: 'a1', knowledgeEnabled: true, memoryWritable: false, noteCount: 2,
      collections: [{ collectionId: 'c1', name: 'Docs', orgId: 'o1', documentCount: 3, chunkCount: 9, documents: [] }],
    }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, KB);
    assert.match(r.stdout, /memoryWritable: no/);
    assert.match(r.stdout, /c1\s+Docs\s+o1\s+3\s+9/);
    assert.match(r.stdout, /notes: 2/);
  });

  it('retrieve POSTs { query } and tabulates chunks; --json passes through', async () => {
    const body = { chunks: [{ content: 'Refunds within 30 days', title: 'FAQ', kind: 'kb', contentTrust: 'trusted' }], hasResults: true };
    let r = await run(['agent-knowledge', 'retrieve', 'a1', '--query', 'refund'], () => json(body));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].path, `${KB}/retrieve`);
    assert.deepEqual(r.calls[0].body, { query: 'refund' });
    assert.match(r.stdout, /kb\s+FAQ\s+trusted\s+Refunds within 30 days/);
    r = await run(['--json', 'agent-knowledge', 'retrieve', 'a1', '--query', 'refund'], () => json(body));
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('bind / unbind hit the bindings routes', async () => {
    let r = await run(['agent-knowledge', 'bind', 'a1', 'c1'], () => json({}, 201));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['POST', `${KB}/bindings`, { collectionId: 'c1' }]);
    r = await run(['agent-knowledge', 'unbind', 'a1', 'c1'], () => new Response(null, { status: 204 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['DELETE', `${KB}/bindings/c1`]);
  });

  it('create-collection / ingest / import carry orgId in the body', async () => {
    let r = await run(['agent-knowledge', 'create-collection', 'a1', '--org', 'o1', '--name', 'Docs'], () => json({ collectionId: 'c2' }, 201));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].body, { orgId: 'o1', name: 'Docs' });
    r = await run(['agent-knowledge', 'ingest', 'a1', 'c2', '--org', 'o1', '--title', 'FAQ', '--text', 'Q/A'], () => json({ documentId: 'd1' }, 201));
    assert.equal(r.calls[0].path, `${KB}/collections/c2/documents`);
    assert.deepEqual(r.calls[0].body, { orgId: 'o1', title: 'FAQ', text: 'Q/A' });
    r = await run(['agent-knowledge', 'import', 'a1', 'c2', '--org', 'o1', '--provider', 'google-drive', '--ref', 'file-1'], () => json({ documentId: 'd2' }, 201));
    assert.equal(r.calls[0].path, `${KB}/collections/c2/documents/from-connection`);
    assert.deepEqual(r.calls[0].body, { orgId: 'o1', provider: 'google-drive', ref: 'file-1' });
  });

  it('create-collection without --org is a usage error', async () => {
    const r = await run(['agent-knowledge', 'create-collection', 'a1', '--name', 'Docs'], () => json({}));
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('delete-document sends { orgId } on the DELETE and needs --yes', async () => {
    let r = await run(['agent-knowledge', 'delete-document', 'a1', 'c2', 'd1', '--org', 'o1'], () => json({}));
    assert.equal(r.code, 2);
    r = await run(['agent-knowledge', 'delete-document', 'a1', 'c2', 'd1', '--org', 'o1', '--yes'], () => new Response(null, { status: 204 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['DELETE', `${KB}/collections/c2/documents/d1`, { orgId: 'o1' }]);
  });

  it('notes / add-note / delete-note / memory-writable', async () => {
    let r = await run(['agent-knowledge', 'notes', 'a1'], () => json({ notes: [{ noteId: 'n1', content: 'Be brief', createdAt: 't' }], recallOnlyCount: 4 }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /n1\s+t\s+Be brief/);
    assert.match(r.stdout, /Recall-only memories \(not removable here\): 4/);
    r = await run(['agent-knowledge', 'add-note', 'a1', '--content', 'Be brief'], () => json({}, 201));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['POST', `${KB}/notes`, { content: 'Be brief' }]);
    r = await run(['agent-knowledge', 'delete-note', 'a1', 'n1', '--yes'], () => new Response(null, { status: 204 }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['DELETE', `${KB}/notes/n1`]);
    r = await run(['agent-knowledge', 'memory-writable', 'a1', '--off'], () => json({ memoryWritable: false }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['PUT', `${KB}/memory-writable`, { writable: false }]);
    r = await run(['agent-knowledge', 'memory-writable', 'a1'], () => json({}));
    assert.equal(r.code, 2);
  });

  it('a 403 (profile policy / scope) exits 4', async () => {
    const r = await run(['agent-knowledge', 'add-note', 'a1', '--content', 'x'], forbidden);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /403/);
  });
});
