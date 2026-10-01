// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// v2 CLIENT obligations beyond path negotiation (test/protocol.test.mjs covers
// that): the error envelope (spec/v2/core/errors.md), tenant-bound id wire
// form (identity.md §5), the poll cursor (events.md §Poll), v1→v2 event names
// (events.md §Types + spec/v2/event-codemap.json), Idempotency-Key
// (idempotency.md, runs.md §Create), minClientVersion + the response header
// (versioning.md §1.4/§1.5), the listRuns cursor (runs.md §List), the
// interrupt resolve body (interrupt.md §Resolve surfaces), and the v2
// discovery representation (capabilities.md §1–§3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  runCli, renderEvent, streamRunEvents, summarizeCapabilities,
  V1_TO_V2_EVENT_TYPES, canonicalEventType, projectTenantBoundId, projectRunIdsInPath,
  errorEnvelope, checkMinClientVersion,
} from '../dist/cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A dual-stack host. `routes(u, init, seen)` answers everything but discovery;
 * `v2doc` is the representation served to `OpenWOP-Version: 2`.
 */
function dualStack(routes, { v2doc = {}, discoveryVersion = '2.0' } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = init.headers ?? {};
    seen.push({ path: u.pathname, search: u.search, raw: String(url), method: init.method ?? 'GET', headers, body: init.body });
    if (u.pathname === '/.well-known/openwop') {
      if (headers['openwop-version']) {
        return json({ protocolVersions: ['1.1', '2.0'], preferredVersion: '1.1', ...v2doc }, 200, discoveryVersion ? { 'openwop-version': discoveryVersion } : {});
      }
      return json({ protocolVersion: '1.1', protocolVersions: ['1.1', '2.0'], preferredVersion: '1.1', capabilities: { interrupts: {} } }, 200, { 'openwop-version': '1.1' });
    }
    return routes(u, init, seen);
  };
  return { seen, fetchImpl };
}

const opts = (h, cap, env = {}) => ({ io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', ...env } });
const base = ['--base-url', 'http://h'];

describe('v2 error envelope (errors.md §The envelope)', () => {
  it('reads the flat v2 shape, the nested legacy shape, and a bare code', () => {
    assert.deepEqual(errorEnvelope({ error: 'not_found', message: 'No route' }), { code: 'not_found', message: 'No route' });
    assert.deepEqual(errorEnvelope({ error: { code: 'run_not_found', message: 'gone' } }), { code: 'run_not_found', message: 'gone' });
    assert.deepEqual(errorEnvelope({ code: 'x', message: '' }), { code: 'x' });
    assert.deepEqual(errorEnvelope({ error: 'validation_error', message: 'bad', details: { field: 'f' } }).details, { field: 'f' });
    assert.deepEqual(errorEnvelope('<html>'), {});
  });

  it('renders HTTP <status> <code>: <message> for both majors', async () => {
    for (const env of [{}, { OPENWOP_PROTOCOL_MAJOR: '1' }]) {
      const cap = capture();
      const h = dualStack(() => json({ error: 'not_found', message: 'run r-1 not found' }, 404));
      assert.equal(await runCli(['runs', 'get', 'r-1', ...base], opts(h, cap, env)), 2);
      assert.match(cap.stderr, /HTTP 404 not_found: run r-1 not found/);
    }
  });

  it('426 client_version_unsupported names the fix', async () => {
    const cap = capture();
    const h = dualStack(() => json({ error: 'client_version_unsupported', message: 'upgrade' }, 426));
    assert.equal(await runCli(['runs', 'list', ...base], opts(h, cap)), 2);
    assert.match(cap.stderr, /HTTP 426 client_version_unsupported: upgrade/);
    assert.match(cap.stderr, /minClientVersion/);
    assert.match(cap.stderr, /openwop upgrade/);
  });

  it('406 protocol_version_unsupported echoes details.protocolVersions', async () => {
    const cap = capture();
    const h = dualStack(() => json({ error: 'protocol_version_unsupported', message: 'no', details: { protocolVersions: ['1.1'] } }, 406));
    await runCli(['runs', 'list', ...base], opts(h, cap));
    assert.match(cap.stderr, /host serves 1\.1/);
    assert.match(cap.stderr, /OPENWOP_PROTOCOL_MAJOR/);
  });

  it('429 surfaces Retry-After (the only home of retry timing)', async () => {
    const cap = capture();
    const h = dualStack(() => json({ error: 'rate_limited', message: 'slow down' }, 429, { 'retry-after': '17' }));
    await runCli(['runs', 'list', ...base], opts(h, cap));
    assert.match(cap.stderr, /retry after 17s/);
  });

  it('401 keeps exit 4 and prints the v2 code', async () => {
    const cap = capture();
    const h = dualStack(() => json({ error: 'unauthenticated', message: 'No credential presented.' }, 401));
    assert.equal(await runCli(['runs', 'list', ...base], opts(h, cap)), 4);
    assert.match(cap.stderr, /HTTP 401 unauthenticated: No credential presented\./);
  });
});

describe('tenant-bound id wire form (identity.md §5)', () => {
  it('projects every byte outside [A-Za-z0-9._-] as ~HH, idempotently', () => {
    assert.equal(projectTenantBoundId('acme/r-9f3c'), 'acme~2Fr-9f3c');
    assert.equal(projectTenantBoundId('anon:abc/xyz'), 'anon~3Aabc~2Fxyz');
    assert.equal(projectTenantBoundId('acme~2Fr-9f3c'), 'acme~2Fr-9f3c', 'an already-projected id is not re-projected');
    assert.equal(projectTenantBoundId('plain-uuid.1_2'), 'plain-uuid.1_2');
    assert.equal(
      projectTenantBoundId('user~3Ad4d0/0c0f66dd'), 'user~7E3Ad4d0~2F0c0f66dd',
      'an id that still has its `/` is projected in full even when its tenant half carries `~` — the form the host links to',
    );
    assert.equal(projectRunIdsInPath('/runs/user~3Ad4d0%2F0c0f66dd/events'), '/runs/user~7E3Ad4d0~2F0c0f66dd/events');
    assert.equal(projectRunIdsInPath('/runs/acme%2Fr1:diff?against=acme%2Fr2'), '/runs/acme~2Fr1:diff?against=acme~2Fr2');
    assert.equal(projectRunIdsInPath('/runs:bulk-cancel'), '/runs:bulk-cancel');
  });

  it('under major 2 a bound runId travels projected on every /runs/{runId} op; under major 1 as %2F on /v1', async () => {
    const ok = () => json({ runId: 'acme/r1', workflowId: 'w', status: 'completed' });
    const h2 = dualStack(ok);
    const cap = capture();
    assert.equal(await runCli(['runs', 'get', 'acme/r1', ...base], opts(h2, cap)), 0, cap.stderr);
    assert.equal(await runCli(['runs', 'fork', 'acme/r1', '--mode', 'replay', ...base], opts(h2, capture())), 0);
    assert.equal(await runCli(['runs', 'diff', 'acme/r1', '--against', 'acme/r2', ...base], opts(h2, capture())), 0);
    const paths = h2.seen.filter((r) => r.path !== '/.well-known/openwop').map((r) => r.raw.replace('http://h', ''));
    assert.deepEqual(paths, ['/runs/acme~2Fr1', '/runs/acme~2Fr1:fork', '/runs/acme~2Fr1:diff?against=acme~2Fr2']);

    const h1 = dualStack(ok);
    await runCli(['runs', 'get', 'acme/r1', ...base], opts(h1, capture(), { OPENWOP_PROTOCOL_MAJOR: '1' }));
    assert.equal(h1.seen.at(-1).raw, 'http://h/v1/runs/acme%2Fr1');
  });
});

describe('poll cursor (events.md §Poll)', () => {
  it('runs events --since sends afterSequence under major 2 and reads isTerminal', async () => {
    const cap = capture();
    const h = dualStack(() => json({ runId: 'r', events: [{ sequence: 4, type: 'run.completed' }], lastSequence: 4, status: 'completed', isTerminal: true }));
    assert.equal(await runCli(['runs', 'events', 'r', '--since', '3', ...base], opts(h, cap)), 0, cap.stderr);
    const poll = h.seen.at(-1);
    assert.equal(poll.path, '/runs/r/events/poll');
    assert.equal(poll.search, '?afterSequence=3');
    assert.match(cap.stdout, /\(run complete\)/);
  });

  it('streamRunEvents poll fallback advances afterSequence and stops on isTerminal (v2)', async () => {
    let call = 0;
    const h = dualStack((u) => {
      call += 1;
      if (call === 1) return json({ events: [{ sequence: 0, type: 'run.started' }], lastSequence: 0, status: 'running', isTerminal: false });
      return json({ events: [{ sequence: 1, type: 'node.completed' }], lastSequence: 1, status: 'completed', isTerminal: true });
    });
    const events = [];
    const ctx = { baseUrl: 'http://h', fetchImpl: h.fetchImpl, env: {}, io: capture().io, json: false, cwd: '/tmp' };
    await streamRunEvents(ctx, 'r', { useStream: false, onEvent: (e) => events.push(e.type), timeoutMs: 5000 });
    assert.deepEqual(events, ['run.started', 'node.completed']);
    const polls = h.seen.filter((r) => r.path.endsWith('/events/poll'));
    assert.deepEqual(polls.map((p) => p.search), ['', '?afterSequence=0']);
  });
});

describe('v1→v2 event names (event-codemap.json)', () => {
  it('the embedded rename table equals the renamed rows of the vendored corpus codemap', () => {
    const map = JSON.parse(readFileSync(new URL('./fixtures/event-codemap.json', import.meta.url), 'utf8'));
    const renamed = Object.fromEntries(map.rows.filter((r) => r.v1 !== r.v2).map((r) => [r.v1, r.v2]));
    assert.deepEqual({ ...V1_TO_V2_EVENT_TYPES }, renamed,
      'src/eventTypes.ts drifted from test/fixtures/event-codemap.json — regenerate V1_TO_V2_EVENT_TYPES');
    assert.equal(Object.keys(renamed).length, map.counts.renamed);
    assert.match(readFileSync(new URL('./fixtures/event-codemap.tag', import.meta.url), 'utf8'), /^v2\.\d+\.\d+/);
  });

  it('canonicalEventType folds v1 names and passes v2 / vendor names through', () => {
    assert.equal(canonicalEventType('run.resuming'), 'run.resume-started');
    assert.equal(canonicalEventType('agent.toolCalled'), 'agent.tool-called');
    assert.equal(canonicalEventType('run.resume-started'), 'run.resume-started');
    assert.equal(canonicalEventType('acme.thing-happened'), 'acme.thing-happened');
  });

  it('renderEvent renders a v1 name and its v2 twin identically', () => {
    assert.equal(renderEvent({ type: 'run.resuming' }), renderEvent({ type: 'run.resume-started' }));
    assert.equal(renderEvent({ type: 'run.resume-started' }), '· run resuming');
    assert.equal(renderEvent({ type: 'run.dead_lettered' }), '! run dead-lettered');
    const called = { nodeId: 'a', payload: { agentId: 'x', toolName: 'search', callId: 'c' } };
    assert.equal(renderEvent({ type: 'agent.toolCalled', ...called }), renderEvent({ type: 'agent.tool-called', ...called }));
    assert.equal(renderEvent({ type: 'agent.tool-called', ...called }), '· a tool search called');
    assert.equal(renderEvent({ type: 'interrupt.requested', nodeId: 'gate', payload: { kind: 'approval' } }), '? gate waiting for approval');
  });
});

describe('Idempotency-Key (idempotency.md §Layer 1; runs.md §Create)', () => {
  it('runs create mints a grammar-valid key; --idempotency-key is sent verbatim; a replay is reported', async () => {
    const h = dualStack((u, init) => json({ runId: 'acme/r1', status: 'pending', eventsUrl: '/runs/acme~2Fr1/events' }, 201,
      init.headers['idempotency-key'] === 'fixed-key-0123456789abcdef' ? { 'openwop-idempotent-replay': 'true' } : {}));
    const cap1 = capture();
    assert.equal(await runCli(['runs', 'create', 'wf', ...base], opts(h, cap1)), 0, cap1.stderr);
    const first = h.seen.at(-1);
    assert.equal(first.path, '/runs');
    assert.match(first.headers['idempotency-key'], /^[A-Za-z0-9._~-]{22,128}$/);
    assert.doesNotMatch(cap1.stdout, /replayed/);

    const cap2 = capture();
    assert.equal(await runCli(['runs', 'create', 'wf', '--idempotency-key', 'fixed-key-0123456789abcdef', ...base], opts(h, cap2)), 0);
    assert.equal(h.seen.at(-1).headers['idempotency-key'], 'fixed-key-0123456789abcdef');
    assert.match(cap2.stdout, /replayed from the idempotency cache/);
  });

  it('an out-of-grammar key is refused locally (exit 2, no request)', async () => {
    const h = dualStack(() => { throw new Error('must not be called'); });
    const cap = capture();
    assert.equal(await runCli(['runs', 'create', 'wf', '--idempotency-key', 'short', ...base], opts(h, cap)), 2);
    assert.match(cap.stderr, /--idempotency-key must match/);
  });
});

describe('listRuns cursor (runs.md §List)', () => {
  it('forwards --cursor/--workflow-id and prints the nextCursor hint', async () => {
    const cap = capture();
    const h = dualStack(() => json({ runs: [{ runId: 'acme/r1', workflowId: 'wf', status: 'completed', startedAt: 't0' }], nextCursor: 'c2' }));
    assert.equal(await runCli(['runs', 'list', '--cursor', 'c1', '--workflow-id', 'wf', ...base], opts(h, cap)), 0);
    const req = h.seen.at(-1);
    assert.equal(req.path, '/runs');
    assert.equal(new URLSearchParams(req.search).get('cursor'), 'c1');
    assert.equal(new URLSearchParams(req.search).get('workflowId'), 'wf');
    assert.match(cap.stdout, /acme\/r1\s+wf\s+completed\s+t0/);
    assert.match(cap.stdout, /openwop runs list --cursor c2/);
  });
});

describe('v2 discovery + client floor (capabilities.md; versioning.md §1.4/§1.5)', () => {
  const v2doc = {
    minClientVersion: '1.0',
    eventLogSchemaVersion: 3,
    engineVersion: 1,
    implementation: { name: 'eng', version: '0.1.0', vendor: 'acme' },
    replay: { status: 'stable', since: '2.0', witness: 'witnessable-gated' },
    runList: { status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated', maxPageSize: 100 },
    extensions: { 'acme.host': { root: '/host/acme/' } },
  };

  it('capabilities renders the v2 root from the negotiation read (one discovery fetch)', async () => {
    const cap = capture();
    const h = dualStack(() => { throw new Error('unexpected'); }, { v2doc });
    assert.equal(await runCli(['capabilities', ...base], opts(h, cap)), 0, cap.stderr);
    assert.equal(h.seen.filter((r) => r.path === '/.well-known/openwop').length, 1);
    assert.match(cap.stdout, /Representation: v2 \(OpenWOP-Version 2\.0\)/);
    assert.match(cap.stdout, /Min client version: 1\.0 \(this CLI speaks 2\.0\)/);
    assert.match(cap.stdout, /Event log schema version: 3/);
    assert.match(cap.stdout, /experimental: runList \(until 2\.1\)/);
    assert.match(cap.stdout, /stable: replay/);
    assert.match(cap.stdout, /Extensions: acme\.host/);
  });

  it('a floor above this CLI warns once on stderr (no extra request, not a refusal)', async () => {
    const cap = capture();
    const h = dualStack(() => json({ runs: [] }), { v2doc: { ...v2doc, minClientVersion: '2.9' } });
    assert.equal(await runCli(['runs', 'list', ...base], opts(h, cap)), 0);
    assert.equal((cap.stderr.match(/minClientVersion 2\.9/g) ?? []).length, 1);
    assert.equal(h.seen.filter((r) => r.path === '/.well-known/openwop').length, 1);
    const quiet = capture();
    await runCli(['runs', 'list', ...base], opts(dualStack(() => json({ runs: [] }), { v2doc }), quiet));
    assert.doesNotMatch(quiet.stderr, /minClientVersion/);
  });

  it('OPENWOP_PROTOCOL_MAJOR=1 reads the header-less v1 document', async () => {
    const cap = capture();
    const h = dualStack(() => { throw new Error('unexpected'); }, { v2doc });
    assert.equal(await runCli(['capabilities', ...base], opts(h, cap, { OPENWOP_PROTOCOL_MAJOR: '1' })), 0);
    const d = h.seen.filter((r) => r.path === '/.well-known/openwop');
    assert.equal(d.length, 1);
    assert.equal(d[0].headers['openwop-version'], undefined);
    assert.match(cap.stdout, /Protocol: 1\.1/);
    assert.match(cap.stdout, /Capability blocks: interrupts/);
  });

  it('summarizeCapabilities lists root families of a wrapper-less v1 document', () => {
    const text = summarizeCapabilities({ protocolVersion: '1.1', implementation: { name: 'n' }, replay: {}, webhooks: {}, supportedTransports: ['rest'] });
    assert.match(text, /Capability blocks: replay, webhooks/);
  });

  it('checkMinClientVersion compares <major>.<minor> and never guesses', () => {
    assert.equal(checkMinClientVersion('2.0', 2).status, 'ok');
    assert.equal(checkMinClientVersion('2.1', 2).status, 'below');
    assert.equal(checkMinClientVersion('2.0', 1).status, 'below');
    assert.equal(checkMinClientVersion(undefined, 2).status, 'unknown');
    assert.equal(checkMinClientVersion('v2', 2).status, 'unknown');
  });

  const doctorRows = async (h) => {
    const cap = capture();
    const code = await runCli(['doctor', '--json', ...base], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const rows = Object.fromEntries(JSON.parse(cap.stdout).checks.map((c) => [c.name, c]));
    return { code, rows };
  };
  const doctorRoutes = (u) => (u.pathname === '/health' ? json({}) : json({ error: 'not_found', message: 'no' }, 404));

  it('doctor: surfaces the response OpenWOP-Version and the client floor', async () => {
    const { rows } = await doctorRows(dualStack(doctorRoutes, { v2doc }));
    assert.equal(rows['response version'].status, 'ok');
    assert.match(rows['response version'].detail ?? rows['response version'].message ?? JSON.stringify(rows['response version']), /2\.0/);
    assert.equal(rows['min client'].status, 'ok');
  });

  it('doctor: a floor above this CLI fails, exit 1', async () => {
    const { code, rows } = await doctorRows(dualStack(doctorRoutes, { v2doc: { ...v2doc, minClientVersion: '2.9' } }));
    assert.equal(rows['min client'].status, 'fail');
    assert.equal(code, 1);
  });

  it('doctor: a v1 header on a major-2 read is a silent downgrade (fail)', async () => {
    const { rows } = await doctorRows(dualStack(doctorRoutes, { v2doc, discoveryVersion: '1.1' }));
    assert.equal(rows['response version'].status, 'fail');
  });
});
