import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';

function capture() { let o = '', e = ''; return { io: { stdout: { write: (s) => { o += s; } }, stderr: { write: (s) => { e += s; } } }, get stdout() { return o; }, get stderr() { return e; } }; }
const json = (b, s = 200) => new Response(b === null ? null : JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const env = { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test', OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' };
/** Run the CLI against a mock host; returns { code, cap, calls } where calls = [{method,path,search,body,auth}]. */
async function run(args, respond = () => json({})) {
  const cap = capture(); const calls = [];
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const call = { method: init.method ?? 'GET', path: url.pathname, search: url.search, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization };
    calls.push(call);
    return respond(call);
  };
  const code = await runCli(args, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env });
  return { code, cap, calls, last: calls[calls.length - 1] };
}
const H = '/v1/host/openwop-app';

describe('tutorials', () => {
  it('list GETs /tutorials and renders a table', async () => {
    const r = await run(['tutorials', 'list'], () => json({ tutorials: [{ id: 't1', category: 'start', title: 'Hello', source: 'seed' }], degraded: false }));
    assert.equal(r.code, 0); assert.equal(r.last.method, 'GET'); assert.equal(r.last.path, `${H}/tutorials`);
    assert.match(r.cap.stdout, /t1\s+start\s+Hello\s+seed/);
  });
  it('get <slug> URL-encodes the slug', async () => {
    const r = await run(['tutorials', 'get', 'a/b'], () => json({ tutorial: { id: 'a/b' } }));
    assert.equal(r.last.path, `${H}/tutorials/a%2Fb`); assert.match(r.cap.stdout, /"tutorial"/);
  });
  it('progress --json returns the body verbatim', async () => {
    const body = { progress: [], persisted: false };
    const r = await run(['--json', 'tutorials', 'progress'], () => json(body));
    assert.equal(r.last.path, `${H}/tutorials/progress`); assert.deepEqual(JSON.parse(r.cap.stdout), body);
  });
  it('progress set POSTs tutorialId + completedStepIds', async () => {
    const r = await run(['tutorials', 'progress', 'set', 't1', '--steps', 'a, b'], () => json({ ok: true, completedStepIds: ['a', 'b'] }));
    assert.equal(r.last.method, 'POST'); assert.deepEqual(r.last.body, { tutorialId: 't1', completedStepIds: ['a', 'b'] });
    assert.match(r.cap.stdout, /Saved 2 completed step/);
  });
  it('progress clear sends mode:clear', async () => {
    const r = await run(['tutorials', 'progress', 'clear', 't1']);
    assert.deepEqual(r.last.body, { tutorialId: 't1', completedStepIds: [], mode: 'clear' });
  });
  it('progress set as anonymous → 403 exit 4 with the host message', async () => {
    const r = await run(['tutorials', 'progress', 'set', 't1', '--steps', 'a'], () => json({ error: 'forbidden', message: 'Sign in to save tutorial progress.' }, 403));
    assert.equal(r.code, 4); assert.match(r.cap.stderr, /HTTP 403( [a-z_]+)?: Sign in to save/);
  });
});

describe('walkthroughs', () => {
  it('progress set POSTs walkthroughId/status/runId', async () => {
    const r = await run(['walkthroughs', 'progress', 'set', 'w1', '--status', 'completed', '--run', 'r1'], () => json({ ok: true }));
    assert.equal(r.last.path, `${H}/walkthroughs/progress`); assert.deepEqual(r.last.body, { walkthroughId: 'w1', status: 'completed', runId: 'r1' });
  });
  it('progress set rejects a bad status (exit 2, no request)', async () => {
    const r = await run(['walkthroughs', 'progress', 'set', 'w1', '--status', 'done', '--run', 'r1']);
    assert.equal(r.code, 2); assert.equal(r.calls.filter((c) => c.path.includes('walkthroughs')).length, 0);
  });
  it('funnel GETs ?walkthroughId= and renders counts', async () => {
    const r = await run(['walkthroughs', 'funnel', 'w1'], () => json({ walkthroughId: 'w1', window: 3, completed: 2, stalledByNode: { n2: 1 } }));
    assert.equal(r.last.path, `${H}/walkthroughs/funnel`); assert.equal(r.last.search, '?walkthroughId=w1');
    assert.match(r.cap.stdout, /completed\s+2/); assert.match(r.cap.stdout, /n2\s+1/);
  });
  it('funnel 403 → exit 4', async () => {
    const r = await run(['walkthroughs', 'funnel', 'w1'], () => json({ error: 'forbidden', message: 'nope' }, 403));
    assert.equal(r.code, 4);
  });
});

describe('widgets', () => {
  it('create POSTs name; archive POSTs /:id/archive; seed POSTs /seed', async () => {
    let r = await run(['widgets', 'create', '--name', 'W'], () => json({ id: 'w1', name: 'W' }, 201));
    assert.equal(r.last.path, `${H}/widgets`); assert.deepEqual(r.last.body, { name: 'W' }); assert.match(r.cap.stdout, /Created widget w1/);
    r = await run(['widgets', 'archive', 'w1'], () => json({ id: 'w1', status: 'archived' }));
    assert.equal(r.last.path, `${H}/widgets/w1/archive`); assert.equal(r.last.method, 'POST');
    r = await run(['widgets', 'seed'], () => json({ seeded: false }));
    assert.equal(r.last.path, `${H}/widgets/seed`); assert.match(r.cap.stdout, /already seeded/);
  });
  it('summary GET + list --json', async () => {
    let r = await run(['widgets', 'summary'], () => json({ total: 2, archived: 1 }));
    assert.equal(r.last.path, `${H}/widgets/summary`); assert.match(r.cap.stdout, /total\s+2/);
    r = await run(['--json', 'widgets', 'list'], () => json({ widgets: [], total: 0 }));
    assert.deepEqual(JSON.parse(r.cap.stdout), { widgets: [], total: 0 });
  });
  it('archive conflict (409) → legible reason, exit 2', async () => {
    const r = await run(['widgets', 'archive', 'w1'], () => json({ error: 'conflict', details: { reason: 'already_archived' } }, 409));
    assert.equal(r.code, 2); assert.match(r.cap.stderr, /already_archived/);
  });
  it('list 404 → "not enabled on this host"', async () => {
    const r = await run(['widgets', 'list'], () => json({ error: 'not_found' }, 404));
    assert.equal(r.code, 2); assert.match(r.cap.stderr, /not enabled on this host/);
  });
});

describe('ui-state', () => {
  it('list passes resourceType/resourceId query', async () => {
    const r = await run(['ui-state', 'list', '--resource-type', 'artifact', '--resource-id', 'a1'], () => json({ items: [{ resourceType: 'artifact', resourceId: 'a1', key: 'k', value: true }] }));
    assert.equal(r.last.path, `${H}/ui-state`); assert.equal(r.last.search, '?resourceType=artifact&resourceId=a1');
    assert.match(r.cap.stdout, /artifact\s+a1\s+k\s+true/);
  });
  it('set PUTs {resourceType,resourceId,key,value} with JSON-parsed value', async () => {
    const r = await run(['ui-state', 'set', 'artifact', 'a1', 'panels', '--value', '{"open":true}']);
    assert.equal(r.last.method, 'PUT'); assert.deepEqual(r.last.body, { resourceType: 'artifact', resourceId: 'a1', key: 'panels', value: { open: true } });
  });
  it('set falls back to a string value', async () => {
    const r = await run(['ui-state', 'set', 'artifact', 'a1', 'mode', '--value', 'side-by-side']);
    assert.equal(r.last.body.value, 'side-by-side');
  });
  it('get filters one key; delete encodes path segments', async () => {
    let r = await run(['ui-state', 'get', 'artifact', 'a1', 'k'], () => json({ items: [{ key: 'x', value: 1 }, { key: 'k', value: 'v' }] }));
    assert.equal(r.cap.stdout.trim(), '"v"');
    r = await run(['ui-state', 'delete', 'artifact', 'a:1', 'k/1'], () => new Response(null, { status: 204 }));
    assert.equal(r.last.method, 'DELETE'); assert.equal(r.last.path, `${H}/ui-state/artifact/a%3A1/k%2F1`);
  });
});

describe('ui-plugin', () => {
  it('packs lists plugins + isolation', async () => {
    const r = await run(['ui-plugin', 'packs'], () => json({ isolation: 'iframe-sandbox', plugins: [{ packName: 'p', pluginId: 'v', tier: 'community' }] }));
    assert.equal(r.last.path, `${H}/ui-plugin/packs`); assert.match(r.cap.stdout, /p\s+v\s+community/); assert.match(r.cap.stdout, /isolation: iframe-sandbox/);
  });
  it('entry prints the raw JS; trusted-entry hits entry.mjs', async () => {
    const js = () => new Response('export default 1;\n', { status: 200, headers: { 'content-type': 'text/javascript' } });
    let r = await run(['ui-plugin', 'entry', 'pack.a', 'viewer'], js);
    assert.equal(r.last.path, `${H}/ui-plugin/packs/pack.a/plugins/viewer/entry`); assert.equal(r.cap.stdout, 'export default 1;\n');
    r = await run(['ui-plugin', 'trusted-entry', 'pack.a', 'viewer'], js);
    assert.equal(r.last.path, `${H}/ui-plugin/trusted/pack.a/plugins/viewer/entry.mjs`);
  });
  it('trusted-entry uniform 404 → exit 2', async () => {
    const r = await run(['ui-plugin', 'trusted-entry', 'p', 'v'], () => json({ error: 'not_found', message: 'Unknown plugin entry.' }, 404));
    assert.equal(r.code, 2); assert.match(r.cap.stderr, /Unknown plugin entry/);
  });
  it('demo-artifact POSTs; rpc wraps a ui-plugin/1 request envelope', async () => {
    let r = await run(['ui-plugin', 'demo-artifact'], () => json({ artifactId: 'a1', version: '3' }));
    assert.equal(r.last.method, 'POST'); assert.match(r.cap.stdout, /Demo artifact a1 \(version 3\)/);
    r = await run(['ui-plugin', 'rpc', '--method', 'artifact.read', '--params', '{"artifactId":"a1"}'], () => json({ ok: true }));
    assert.equal(r.last.path, `${H}/ui-plugin/rpc`);
    assert.deepEqual(r.last.body, { message: { openwop: 'ui-plugin/1', type: 'request', id: 1, method: 'artifact.read', params: { artifactId: 'a1' } } });
  });
  it('rpc --conformance-alias targets /v1/host/sample; --body passes through', async () => {
    const r = await run(['ui-plugin', 'rpc', '--conformance-alias', '--body', '{"message":{"x":1}}']);
    assert.equal(r.last.path, '/v1/host/sample/ui-plugin/rpc'); assert.deepEqual(r.last.body, { message: { x: 1 } });
  });
});

describe('canvas-collab + workflow-collab', () => {
  it('canvas ticket POSTs and prints the ticket once with a stderr warning', async () => {
    const r = await run(['canvas-collab', 'ticket', 'c/1'], () => json({ ticket: 'TKT' }));
    assert.equal(r.last.method, 'POST'); assert.equal(r.last.path, `${H}/canvas-collab/c%2F1/ticket`);
    assert.equal(r.cap.stdout.trim(), 'TKT'); assert.match(r.cap.stderr, /credential/);
  });
  it('canvas claim-seed + debug', async () => {
    let r = await run(['canvas-collab', 'claim-seed', 'c1'], () => json({ seed: true }));
    assert.equal(r.last.path, `${H}/canvas-collab/c1/claim-seed`); assert.match(r.cap.stdout, /won the seed election/);
    r = await run(['canvas-collab', 'debug'], () => json({ instanceRooms: [] }));
    assert.equal(r.last.path, `${H}/canvas-collab/_debug`); assert.match(r.cap.stdout, /No live collaboration rooms/);
  });
  it('canvas debug without super-admin → exit 4', async () => {
    const r = await run(['canvas-collab', 'debug'], () => json({ error: 'forbidden', message: 'super-admin only' }, 403));
    assert.equal(r.code, 4); assert.match(r.cap.stderr, /super-admin only/);
  });
  it('workflow ticket/claim-seed hit /workflow-collab', async () => {
    let r = await run(['--json', 'workflow-collab', 'ticket', 'wf1'], () => json({ ticket: 'T2' }));
    assert.equal(r.last.path, `${H}/workflow-collab/wf1/ticket`); assert.deepEqual(JSON.parse(r.cap.stdout), { ticket: 'T2' });
    r = await run(['workflow-collab', 'claim-seed', 'wf1'], () => json({ seed: false }));
    assert.equal(r.last.path, `${H}/workflow-collab/wf1/claim-seed`); assert.match(r.cap.stdout, /seed: false/);
  });
});

describe('canvas-packs', () => {
  it('types --org GETs the org route', async () => {
    const r = await run(['canvas-packs', 'types', '--org', 'o 1'], () => json({ types: [{ canvasTypeId: 'canvas.x', title: 'X' }] }));
    assert.equal(r.last.path, `${H}/canvas-packs/orgs/o%201/types`); assert.match(r.cap.stdout, /canvas\.x\s+X/);
  });
  it('defaults to types; missing --org → exit 2', async () => {
    const r = await run(['canvas-packs']);
    assert.equal(r.code, 2); assert.match(r.cap.stderr, /--org/);
  });
});

describe('present', () => {
  it('outline sends NO bearer (token is the credential)', async () => {
    const r = await run(['present', 'outline', 'tok'], () => json({ title: 'Deck', frames: [{ title: 'One' }, { title: 'Two' }], current: 1 }));
    assert.equal(r.last.path, `${H}/present/tok/outline`); assert.equal(r.last.auth, undefined);
    assert.match(r.cap.stdout, /Deck — 2 frame\(s\), current 1/);
  });
  it('command goto POSTs action+index; state POSTs current', async () => {
    let r = await run(['present', 'command', 'tok', 'goto', '--index', '3'], () => json({ ok: true }, 202));
    assert.deepEqual(r.last.body, { action: 'goto', index: 3 }); assert.equal(r.last.path, `${H}/present/tok/command`);
    r = await run(['present', 'state', 'tok', '--current', '2'], () => json({ ok: true }, 202));
    assert.deepEqual(r.last.body, { current: 2 });
  });
  it('command rejects an unknown action (exit 2)', async () => {
    const r = await run(['present', 'command', 'tok', 'jump']);
    assert.equal(r.code, 2);
  });
  it('events consumes the SSE nav feed up to --max', async () => {
    const sse = 'event: nav\ndata: {"kind":"command","action":"next"}\n\nevent: nav\ndata: {"kind":"position","current":4}\n\n';
    const r = await run(['--json', 'present', 'events', 'tok', '--max', '2'], () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    assert.equal(r.last.path, `${H}/present/tok/events`);
    const lines = r.cap.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ event: 'nav', data: { kind: 'command', action: 'next' } }, { event: 'nav', data: { kind: 'position', current: 4 } }]);
  });
  it('expired token → uniform 404, exit 2', async () => {
    const r = await run(['present', 'outline', 'bad'], () => json({ error: 'not_found', message: 'unknown or expired present session' }, 404));
    assert.equal(r.code, 2); assert.match(r.cap.stderr, /expired present session/);
  });
});

describe('sharing card / frame-view / frame-views', () => {
  it('card GETs /shared/:token/card without auth', async () => {
    const r = await run(['sharing', 'card', 'sh1'], () => json({ title: 'T', description: 'D' }));
    assert.equal(r.last.path, `${H}/shared/sh1/card`); assert.equal(r.last.auth, undefined); assert.match(r.cap.stdout, /title\s+T/);
  });
  it('frame-view POSTs {frame} without auth', async () => {
    const r = await run(['sharing', 'frame-view', 'sh1', '--frame', '2'], () => new Response(null, { status: 204 }));
    assert.equal(r.last.method, 'POST'); assert.equal(r.last.path, `${H}/shared/sh1/frame-view`); assert.deepEqual(r.last.body, { frame: 2 }); assert.equal(r.last.auth, undefined);
  });
  it('frame-views reads the owner analytics route', async () => {
    const r = await run(['sharing', 'frame-views', 'sh1', '--org', 'o1'], () => json({ frames: [{ frame: 0, count: 5 }] }));
    assert.equal(r.last.path, `${H}/sharing/orgs/o1/links/sh1/frame-views`); assert.match(r.cap.stdout, /0\s+5/);
  });
  it('frame-views 403 → exit 4', async () => {
    const r = await run(['sharing', 'frame-views', 'sh1', '--org', 'o1'], () => json({ error: 'forbidden' }, 403));
    assert.equal(r.code, 4);
  });
});
