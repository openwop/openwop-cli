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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const B = '/v1/host/openwop-app/brand';

describe('brand-kits command', () => {
  it('list renders brands from GET …/brand/brands?orgId=', async () => {
    const cap = capture();
    const r = recorder(() => json({ brands: [{ id: 'br_1', name: 'Acme', orgId: 'org_1', status: 'active', governance: { lockLevel: 'partial' } }] }));
    assert.equal(await runCli(['brand-kits', 'list', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [`GET ${B}/brands?orgId=org_1`]);
    assert.match(cap.stdout, /br_1\s+Acme\s+org_1\s+active\s+partial/);
  });

  it('channels / get / audit / fonts --json print the raw body', async () => {
    const cap = capture();
    const r = recorder(() => json({ ok: 1 }));
    for (const argv of [['channels'], ['get', 'br/1'], ['audit', 'br/1'], ['fonts', 'br/1']]) {
      assert.equal(await runCli(['brand-kits', ...argv, '--json'], opts(r.fetchImpl, cap)), 0);
    }
    assert.deepEqual(r.calls.map((c) => c.path), [`${B}/channels`, `${B}/brands/br%2F1`, `${B}/brands/br%2F1/audit`, `${B}/brands/br%2F1/fonts`]);
    assert.match(cap.stdout, /"ok": 1/);
  });

  it('create POSTs orgId + flags merged over --body', async () => {
    const cap = capture();
    const r = recorder(() => json({ brand: { id: 'br_9', name: 'N' } }, 201));
    assert.equal(await runCli(['brand-kits', 'create', '--org', 'org_1', '--name', 'N', '--parent-brand-id', 'br_0', '--body', '{"keyPhrases":["x"],"name":"old"}'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].path, `${B}/brands`);
    assert.deepEqual(r.calls[0].body, { keyPhrases: ['x'], name: 'N', parentBrandId: 'br_0', orgId: 'org_1' });
    assert.match(cap.stdout, /Created brand br_9/);
  });

  it('update PATCHes the fields + expectedUpdatedAt', async () => {
    const cap = capture();
    const r = recorder(() => json({ brand: { id: 'br_1' } }));
    assert.equal(await runCli(['brand-kits', 'update', 'br_1', '--status', 'archived', '--expected-updated-at', '2026-01-01T00:00:00Z'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].method, 'PATCH');
    assert.deepEqual(r.calls[0].body, { status: 'archived', expectedUpdatedAt: '2026-01-01T00:00:00Z' });
  });

  it('font-set PUTs base64 content + licenseAttested; font-delete needs --yes', async () => {
    const cap = capture();
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const file = join(dir, 'f.woff2');
    writeFileSync(file, 'font-bytes');
    const r = recorder(() => json({ font: { role: 'sans', family: 'Inter' } }, 201));
    assert.equal(await runCli(['brand-kits', 'font-set', 'br_1', 'sans', '--file', file, '--license-attested'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].method, 'PUT');
    assert.equal(r.calls[0].path, `${B}/brands/br_1/fonts/sans`);
    assert.deepEqual(r.calls[0].body, { contentBase64: Buffer.from('font-bytes').toString('base64'), licenseAttested: true });
    assert.equal(await runCli(['brand-kits', 'font-set', 'br_1', 'mono', '--file', file], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['brand-kits', 'font-delete', 'br_1', 'sans'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 1);
    assert.equal(await runCli(['brand-kits', 'font-delete', 'br_1', 'sans', '--yes'], opts(async (u, i) => { r.calls.push({ method: i.method, path: new URL(u).pathname }); return new Response(null, { status: 204 }); }, cap)), 0);
    assert.deepEqual(r.calls.at(-1), { method: 'DELETE', path: `${B}/brands/br_1/fonts/sans` });
  });

  it('delete refuses without --yes, then DELETEs', async () => {
    const cap = capture();
    const r = recorder(() => json({ deleted: true, brandId: 'br_1' }));
    assert.equal(await runCli(['brand-kits', 'delete', 'br_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['brand-kits', 'delete', 'br_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`DELETE ${B}/brands/br_1`]);
  });

  it('a governance-lock 403 is legible with exit 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'This brand is locked — only an org admin may edit it.' }, 403));
    assert.equal(await runCli(['brand-kits', 'update', 'br_1', '--name', 'X'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: This brand is locked/);
  });

  it('help cross-references the app-wide brand group (and vice versa)', async () => {
    const cap = capture();
    assert.equal(await runCli(['brand-kits', '--help'], opts(async () => json({}), cap)), 0);
    assert.match(cap.stdout, /openwop brand'/);
    const cap2 = capture();
    assert.equal(await runCli(['brand', '--help'], opts(async () => json({}), cap2)), 0);
    assert.match(cap2.stdout, /openwop brand-kits/);
  });
});
