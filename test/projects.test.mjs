// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const P = '/v1/host/openwop-app/projects/p1';

describe('projects (extended)', () => {
  it('update sends workflows as an array and charter as JSON', async () => {
    const host = mockHost(() => json({ id: 'p1' }));
    const cap = capture();
    assert.equal(await runCli(['projects', 'update', 'p1', '--workflows', 'wf.a,wf.b', '--charter', '{"goal":"Ship"}'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PATCH');
    assert.deepEqual(host.last().body, { workflows: ['wf.a', 'wf.b'], charter: { goal: 'Ship' } });
  });

  it('members add carries --role; ref with a colon is fine in the body', async () => {
    const host = mockHost(() => json({ members: [] }, 201));
    const cap = capture();
    await runCli(['projects', 'members', 'add', 'p1', '--ref', 'agent:r7', '--role', 'lead'], opts(host, cap));
    assert.equal(host.last().path, `${P}/members`);
    assert.deepEqual(host.last().body, { ref: 'agent:r7', role: 'lead' });
  });

  it('knowledge documents add uploads a binary file as base64 inside JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owcli-'));
    const file = join(dir, 'a.bin');
    writeFileSync(file, Buffer.from([0, 1, 2, 255]));
    const host = mockHost(() => json({ documentId: 'd1' }, 201));
    const cap = capture();
    await runCli(['projects', 'knowledge', 'documents', 'add', 'p1', 'kc 1', '--org', 'o1', '--file', file, '--content-type', 'application/octet-stream'], opts(host, cap));
    assert.equal(host.last().path, `${P}/knowledge/collections/kc%201/documents`);
    assert.deepEqual(host.last().body, { orgId: 'o1', contentBase64: 'AAEC/w==', contentType: 'application/octet-stream' });
  });

  it('knowledge documents remove is a DELETE carrying orgId, gated on --yes', async () => {
    const host = mockHost(() => json(null, 204));
    let cap = capture();
    assert.equal(await runCli(['projects', 'knowledge', 'documents', 'remove', 'p1', 'kc1', 'd1', '--org', 'o1'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['projects', 'knowledge', 'documents', 'remove', 'p1', 'kc1', 'd1', '--org', 'o1', '--yes'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'DELETE');
    assert.deepEqual(host.last().body, { orgId: 'o1' });
  });

  it('schedules table + update --no-enabled', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { schedules: [{ jobId: 'j1', cronExpr: '0 9 * * 1', enabled: true, workflowId: 'wf' }] } : { jobId: 'j1' }));
    let cap = capture();
    await runCli(['projects', 'schedules', 'p1'], opts(host, cap));
    assert.match(cap.stdout, /j1\s+0 9 \* \* 1\s+true\s+wf/);
    cap = capture();
    await runCli(['projects', 'schedules', 'update', 'p1', 'j1', '--no-enabled'], opts(host, cap));
    assert.equal(host.last().path, `${P}/schedules/j1`);
    assert.deepEqual(host.last().body, { enabled: false });
  });

  it('visibility / memory add / chat hit their paths; 403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden_scope' }, 403));
    const cap = capture();
    assert.equal(await runCli(['projects', 'visibility', 'p1', '--visibility', 'private'], opts(host, cap)), 4);
    assert.equal(host.last().path, `${P}/visibility`);
    const ok = mockHost(() => json({ sessionId: 's1' }, 201));
    await runCli(['projects', 'memory', 'add', 'p1', '--content', 'note'], opts(ok, capture()));
    assert.deepEqual(ok.last().body, { content: 'note' });
    await runCli(['projects', 'chat', 'p1'], opts(ok, capture()));
    assert.equal(ok.last().path, `${P}/chat`);
  });
});
