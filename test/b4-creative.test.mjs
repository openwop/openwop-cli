import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture() { let o = '', e = ''; return { io: { stdout: { write: (s) => { o += s; } }, stderr: { write: (s) => { e += s; } } }, get stdout() { return o; }, get stderr() { return e; } }; }
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const ctx = (cap, f, cwd = process.cwd()) => ({ io: cap.io, fetchImpl: f, cwd, repoRoot: cwd, env: { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test', OPENWOP_API_KEY: 'k' } });
const isDiscovery = (u) => /well-known/.test(String(u));
/** Record every non-discovery call; `reply(call)` returns the Response. */
function recorder(reply) {
  const calls = [];
  const f = async (u, i = {}) => {
    if (isDiscovery(u)) return json({});
    const url = new URL(u);
    const call = { method: i.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body: i.body ? JSON.parse(i.body) : undefined, auth: i.headers?.authorization };
    calls.push(call);
    return reply(call);
  };
  return { calls, f };
}
const CB = '/v1/host/openwop-app/creative-briefs/orgs/o1';
const CV = '/v1/host/openwop-app/creative-video/orgs/o1';
const PR = '/v1/host/openwop-app/production/orgs/o1';

describe('creative-briefs', () => {
  it('list renders a table from {briefs}', async () => {
    const cap = capture(); const r = recorder(() => json({ briefs: [{ briefId: 'b1', title: 'Hero', assetType: 'image', status: 'draft', version: 1 }] }));
    assert.equal(await runCli(['creative-briefs', 'list', '--org', 'o1'], ctx(cap, r.f)), 0);
    assert.equal(r.calls[0].method, 'GET'); assert.equal(r.calls[0].path, `${CB}/briefs`);
    assert.match(cap.stdout, /b1\s+Hero\s+image\s+draft\s+1/);
  });
  it('list --json prints the host body', async () => {
    const cap = capture(); const r = recorder(() => json({ briefs: [] }));
    await runCli(['--json', 'creative-briefs', 'list', '--org', 'o1'], ctx(cap, r.f));
    assert.deepEqual(JSON.parse(cap.stdout), { briefs: [] });
  });
  it('create maps flags to title/sceneDescription/assetType and merges --body', async () => {
    const cap = capture(); const r = recorder(() => json({ briefId: 'b9' }, 201));
    await runCli(['creative-briefs', 'create', '--org', 'o1', '--title', 'T', '--scene', 'S', '--asset-type', 'video', '--body', '{"lighting":"golden","title":"ignored"}'], ctx(cap, r.f));
    assert.equal(r.calls[0].method, 'POST'); assert.equal(r.calls[0].path, `${CB}/briefs`);
    assert.deepEqual(r.calls[0].body, { lighting: 'golden', title: 'T', sceneDescription: 'S', assetType: 'video' });
    assert.match(cap.stdout, /Created creative brief b9/);
  });
  it('create without --scene exits 2', async () => {
    const cap = capture(); const r = recorder(() => json({}));
    assert.equal(await runCli(['creative-briefs', 'create', '--org', 'o1', '--title', 'T'], ctx(cap, r.f)), 2);
    assert.equal(r.calls.length, 0); assert.match(cap.stderr, /--scene/);
  });
  it('update PATCHes the brief (url-encoded id)', async () => {
    const cap = capture(); const r = recorder(() => json({ briefId: 'a/b', version: 2, status: 'draft' }));
    await runCli(['creative-briefs', 'update', 'a/b', '--org', 'o1', '--title', 'New'], ctx(cap, r.f));
    assert.equal(r.calls[0].method, 'PATCH'); assert.equal(r.calls[0].path, `${CB}/briefs/a%2Fb`);
    assert.deepEqual(r.calls[0].body, { title: 'New' });
  });
  it('delete requires --yes, then DELETEs', async () => {
    let cap = capture(); let r = recorder(() => new Response(null, { status: 204 }));
    assert.equal(await runCli(['creative-briefs', 'delete', 'b1', '--org', 'o1'], ctx(cap, r.f)), 2);
    assert.equal(r.calls.length, 0);
    cap = capture();
    assert.equal(await runCli(['creative-briefs', 'delete', 'b1', '--org', 'o1', '--yes'], ctx(cap, r.f)), 0);
    assert.equal(r.calls[0].method, 'DELETE'); assert.equal(r.calls[0].path, `${CB}/briefs/b1`);
  });
  it('transition POSTs {status}; a 403 on approve exits 4 legibly', async () => {
    let cap = capture(); let r = recorder(() => json({ status: 'review' }));
    await runCli(['creative-briefs', 'transition', 'b1', '--org', 'o1', '--status', 'review'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CB}/briefs/b1/transition`); assert.deepEqual(r.calls[0].body, { status: 'review' });
    cap = capture(); r = recorder(() => json({ error: 'forbidden', message: 'Requires host:members:manage' }, 403));
    assert.equal(await runCli(['creative-briefs', 'transition', 'b1', '--org', 'o1', '--status', 'approved'], ctx(cap, r.f)), 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Requires host:members:manage/);
  });
  it('versions + diff hit the right paths with ?from&to', async () => {
    const cap = capture(); const r = recorder((c) => json(c.path.endsWith('/diff') ? { changes: [{ field: 'title', from: 'a', to: 'b' }] } : { versions: [] }));
    await runCli(['creative-briefs', 'versions', 'b1', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['creative-briefs', 'diff', 'b1', '--org', 'o1', '--from', '1', '--to', '3'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CB}/briefs/b1/versions`);
    assert.equal(r.calls[1].path, `${CB}/briefs/b1/diff`); assert.deepEqual(r.calls[1].query, { from: '1', to: '3' });
    assert.match(cap.stdout, /title\s+a\s+b/);
  });
  it('moodboard POSTs product/useCase/personaIds/limit', async () => {
    const cap = capture(); const r = recorder(() => json({ moodBoard: [{}, {}] }));
    await runCli(['creative-briefs', 'moodboard', 'b1', '--org', 'o1', '--product', 'bike', '--use-case', 'ads', '--persona-ids', 'p1,p2', '--limit', '4'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CB}/briefs/b1/moodboard`);
    assert.deepEqual(r.calls[0].body, { product: 'bike', useCase: 'ads', personaIds: ['p1', 'p2'], limit: 4 });
    assert.match(cap.stdout, /2 items/);
  });
  it('pdf writes the returned bytes to --output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-cb-'));
    const cap = capture(); const r = recorder(() => new Response(Buffer.from('%PDF-1.4 x'), { status: 200, headers: { 'content-type': 'application/pdf' } }));
    assert.equal(await runCli(['creative-briefs', 'pdf', 'b1', '--org', 'o1', '--output', 'out.pdf'], ctx(cap, r.f, dir)), 0);
    assert.equal(r.calls[0].method, 'POST'); assert.equal(r.calls[0].path, `${CB}/briefs/b1/pdf`); assert.equal(r.calls[0].auth, 'Bearer k');
    assert.equal(readFileSync(join(dir, 'out.pdf'), 'utf8'), '%PDF-1.4 x');
  });
  it('reel POSTs directionIndex/aspectRatio/durationSeconds and prints the runId', async () => {
    const cap = capture(); const r = recorder(() => json({ runId: 'run_1', status: 'pending' }, 202));
    await runCli(['creative-briefs', 'reel', 'b1', '--org', 'o1', '--direction-index', '1', '--aspect-ratio', '9:16', '--duration-seconds', '8'], ctx(cap, r.f));
    assert.deepEqual(r.calls[0].body, { directionIndex: 1, aspectRatio: '9:16', durationSeconds: 8 });
    assert.match(cap.stdout, /run_1/);
  });
  it('render-templates + renders list/create/delete', async () => {
    const cap = capture(); const r = recorder((c) => c.method === 'DELETE' ? new Response(null, { status: 204 }) : json(c.method === 'POST' ? { renders: [{}, {}] } : { templates: [{ templateId: 'meta.feed.1x1', platform: 'meta', format: 'feed', width: 1080, height: 1080 }] }));
    await runCli(['creative-briefs', 'render-templates', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['creative-briefs', 'renders', 'list', 'b1', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['creative-briefs', 'renders', 'create', 'b1', '--org', 'o1', '--templates', 'a,b', '--animate'], ctx(cap, r.f));
    await runCli(['creative-briefs', 'renders', 'delete', 'b1', 'r1', '--org', 'o1', '--yes'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CB}/render-templates`);
    assert.equal(r.calls[1].path, `${CB}/briefs/b1/renders`);
    assert.equal(r.calls[2].method, 'POST'); assert.deepEqual(r.calls[2].body, { templateIds: ['a', 'b'], animate: true });
    assert.equal(r.calls[3].method, 'DELETE'); assert.equal(r.calls[3].path, `${CB}/briefs/b1/renders/r1`);
    assert.match(cap.stdout, /meta\.feed\.1x1/);
  });
  it('commands without --org exit 2', async () => {
    const cap = capture();
    assert.equal(await runCli(['creative-briefs', 'list'], ctx(cap, async () => json({}))), 2);
    assert.match(cap.stderr, /--org/);
  });
});

describe('creative-video', () => {
  it('jobs list + jobs get', async () => {
    const cap = capture(); const r = recorder((c) => json(c.path.endsWith('/jobs') ? { jobs: [{ jobId: 'j1', kind: 'avatar', status: 'processing', provider: 'heygen' }] } : { jobId: 'j1', kind: 'avatar', status: 'completed', assetId: 'a1' }));
    await runCli(['creative-video', 'jobs', 'list', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['creative-video', 'jobs', 'get', 'j1', '--org', 'o1'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CV}/jobs`); assert.equal(r.calls[1].path, `${CV}/jobs/j1`);
    assert.match(cap.stdout, /j1\s+avatar\s+processing\s+heygen/); assert.match(cap.stdout, /completed\s+asset a1/);
  });
  it('generate POSTs script/avatarId/voiceId', async () => {
    const cap = capture(); const r = recorder(() => json({ jobId: 'j2', status: 'processing' }, 201));
    await runCli(['creative-video', 'generate', '--org', 'o1', '--script', 'hi', '--avatar', 'av', '--voice', 'v'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${CV}/generate`); assert.deepEqual(r.calls[0].body, { script: 'hi', avatarId: 'av', voiceId: 'v' });
    assert.match(cap.stdout, /j2/);
  });
  it('text-to-video POSTs prompt/model/durationSec; a 409 no_connection is legible, exit 2', async () => {
    const cap = capture(); const r = recorder(() => json({ status: 'failed', error: 'no_connection' }, 409));
    assert.equal(await runCli(['creative-video', 'text-to-video', '--org', 'o1', '--prompt', 'p', '--model', 'm', '--duration-sec', '5'], ctx(cap, r.f)), 2);
    assert.equal(r.calls[0].path, `${CV}/text-to-video`); assert.deepEqual(r.calls[0].body, { prompt: 'p', model: 'm', durationSec: 5 });
    assert.match(cap.stderr, /no_connection/);
  });
  it('403 exits 4', async () => {
    const cap = capture(); const r = recorder(() => json({ message: 'Forbidden' }, 403));
    assert.equal(await runCli(['creative-video', 'jobs', 'list', '--org', 'o1'], ctx(cap, r.f)), 4);
  });
});

describe('production', () => {
  it('plans list/get/status', async () => {
    const cap = capture(); const r = recorder((c) => json(c.path.endsWith('/plans') ? { plans: [{ planId: 'p1', status: 'draft' }] } : { planId: 'p1', status: 'approved' }));
    await runCli(['production', 'plans', 'list', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['production', 'plans', 'get', 'p1', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['production', 'plans', 'status', 'p1', '--org', 'o1', '--status', 'approved'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${PR}/plans`); assert.equal(r.calls[1].path, `${PR}/plans/p1`);
    assert.equal(r.calls[2].method, 'POST'); assert.equal(r.calls[2].path, `${PR}/plans/p1/status`); assert.deepEqual(r.calls[2].body, { status: 'approved' });
    assert.match(cap.stdout, /p1\s+draft/);
  });
  it('vendors list passes q/type/contractStatus', async () => {
    const cap = capture(); const r = recorder(() => json({ vendors: [{ vendorId: 'v1', name: 'Blue', type: 'agency', contractStatus: 'active' }] }));
    await runCli(['production', 'vendors', 'list', '--org', 'o1', '--q', 'blue', '--type', 'agency', '--contract-status', 'active'], ctx(cap, r.f));
    assert.equal(r.calls[0].path, `${PR}/vendors`); assert.deepEqual(r.calls[0].query, { q: 'blue', type: 'agency', contractStatus: 'active' });
    assert.match(cap.stdout, /v1\s+Blue\s+agency\s+active/);
  });
  it('vendors create/update/get/delete', async () => {
    const cap = capture(); const r = recorder((c) => c.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ vendorId: 'v1' }));
    await runCli(['production', 'vendors', 'create', '--org', 'o1', '--name', 'Blue', '--type', 'agency', '--contact-email', 'a@b.c', '--company', 'c1', '--body', '{"capabilities":[{"category":"video"}]}'], ctx(cap, r.f));
    await runCli(['production', 'vendors', 'update', 'v1', '--org', 'o1', '--region', 'EU'], ctx(cap, r.f));
    await runCli(['production', 'vendors', 'get', 'v1', '--org', 'o1'], ctx(cap, r.f));
    await runCli(['production', 'vendors', 'delete', 'v1', '--org', 'o1', '--yes'], ctx(cap, r.f));
    assert.deepEqual(r.calls[0].body, { capabilities: [{ category: 'video' }], name: 'Blue', type: 'agency', contactEmail: 'a@b.c', companyId: 'c1' });
    assert.equal(r.calls[1].method, 'PATCH'); assert.deepEqual(r.calls[1].body, { region: 'EU' });
    assert.equal(r.calls[2].method, 'GET'); assert.equal(r.calls[3].method, 'DELETE'); assert.equal(r.calls[3].path, `${PR}/vendors/v1`);
  });
  it('vendors portfolio --add is read-modify-write over the replacing PUT', async () => {
    const cap = capture(); const r = recorder((c) => json(c.method === 'GET' ? { vendorId: 'v1', portfolioAssetTokens: ['t1', 't2'] } : { portfolioAssetTokens: c.body.tokens }));
    await runCli(['production', 'vendors', 'portfolio', 'v1', '--org', 'o1', '--add', 't2,t3'], ctx(cap, r.f));
    assert.equal(r.calls[0].method, 'GET'); assert.equal(r.calls[1].method, 'PUT'); assert.equal(r.calls[1].path, `${PR}/vendors/v1/portfolio`);
    assert.deepEqual(r.calls[1].body, { tokens: ['t1', 't2', 't3'] });
    assert.match(cap.stdout, /3 asset tokens/);
  });
  it('vendors portfolio --remove and --set', async () => {
    const cap = capture(); const r = recorder((c) => json(c.method === 'GET' ? { portfolioAssetTokens: ['t1', 't2'] } : { portfolioAssetTokens: c.body.tokens }));
    await runCli(['production', 'vendors', 'portfolio', 'v1', '--org', 'o1', '--remove', 't1'], ctx(cap, r.f));
    await runCli(['production', 'vendors', 'portfolio', 'v1', '--org', 'o1', '--set', 'x'], ctx(cap, r.f));
    assert.deepEqual(r.calls[1].body, { tokens: ['t2'] });
    assert.equal(r.calls[2].method, 'PUT'); assert.deepEqual(r.calls[2].body, { tokens: ['x'] });
  });
  it('reindex-kb POSTs and --json prints the verbatim result', async () => {
    const cap = capture(); const r = recorder(() => json({ indexed: 3, removedOrphans: 0, complete: true }));
    await runCli(['--json', 'production', 'reindex-kb', '--org', 'o1'], ctx(cap, r.f));
    assert.equal(r.calls[0].method, 'POST'); assert.equal(r.calls[0].path, `${PR}/reindex-kb`);
    assert.deepEqual(JSON.parse(cap.stdout), { indexed: 3, removedOrphans: 0, complete: true });
  });
  it('403 exits 4', async () => {
    const cap = capture(); const r = recorder(() => json({ message: 'Not a member' }, 403));
    assert.equal(await runCli(['production', 'vendors', 'list', '--org', 'o1'], ctx(cap, r.f)), 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Not a member/);
  });
});
