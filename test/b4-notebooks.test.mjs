import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture() { let o = '', e = ''; return { io: { stdout: { write: (s) => { o += s; } }, stderr: { write: (s) => { e += s; } } }, get stdout() { return o; }, get stderr() { return e; } }; }
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const ctx = (cap, f, cwd = process.cwd()) => ({ io: cap.io, fetchImpl: f, cwd, repoRoot: process.cwd(), env: { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test', OPENWOP_API_KEY: 'k' } });

/** Run the CLI capturing every non-discovery request. */
async function run(argv, respond = () => json({}), cwd) {
  const calls = []; const cap = capture();
  const code = await runCli(argv, ctx(cap, async (u, i = {}) => {
    const url = new URL(u);
    if (url.pathname.includes('.well-known')) return json({}, 404);
    calls.push({ method: i.method ?? 'GET', path: url.pathname, search: url.search, body: i.body ? JSON.parse(i.body) : undefined });
    return respond(url, i);
  }, cwd));
  return { code, calls, cap, last: calls[calls.length - 1] };
}

describe('notebooks (b4)', () => {
  it('ensure POSTs /notebooks/{id}/ensure', async () => {
    const { code, last, cap } = await run(['notebooks', 'ensure', 'p 1'], () => json({ notebook: { id: 'p 1' }, collectionId: 'c1' }));
    assert.equal(code, 0); assert.equal(last.method, 'POST'); assert.match(last.path, /\/notebooks\/p%201\/ensure$/);
    assert.match(cap.stdout, /collection c1/);
  });
  it('notes add sends text + origin (authored → trusted)', async () => {
    const { last } = await run(['notebooks', 'notes', 'add', 'n1', '--text', 'hi', '--authored']);
    assert.equal(last.method, 'POST'); assert.match(last.path, /\/notebooks\/n1\/notes$/);
    assert.deepEqual(last.body, { text: 'hi', origin: 'authored' });
    const r2 = await run(['notebooks', 'notes', 'add', 'n1', '--text', 'x']);
    assert.equal(r2.last.body.origin, 'third-party');
  });
  it('notes <id> (legacy) lists and renders a table', async () => {
    const { last, cap } = await run(['notebooks', 'notes', 'n1'], () => json({ notes: [{ id: 'nt1', origin: 'authored', text: 'hello' }] }));
    assert.equal(last.method, 'GET'); assert.match(cap.stdout, /nt1\s+authored\s+hello/);
  });
  it('sources add --file sends base64 + inferred MIME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-nb-')); writeFileSync(join(dir, 'a.txt'), 'abc');
    const { last } = await run(['notebooks', 'sources', 'add', 'n1', '--file', 'a.txt', '--title', 'A'], () => json({ id: 's1' }), dir);
    assert.match(last.path, /\/notebooks\/n1\/sources$/);
    assert.deepEqual(last.body, { title: 'A', contentBase64: Buffer.from('abc').toString('base64'), contentType: 'text/plain' });
  });
  it('sources audio posts base64 audio with language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-nb-')); writeFileSync(join(dir, 'c.mp3'), Buffer.from([1, 2, 3]));
    const { last, cap } = await run(['notebooks', 'sources', 'audio', 'n1', '--file', 'c.mp3', '--language', 'en'], () => json({ runId: 'r1' }), dir);
    assert.match(last.path, /\/sources\/audio$/); assert.equal(last.body.contentType, 'audio/mpeg'); assert.equal(last.body.language, 'en');
    assert.equal(last.body.contentBase64, 'AQID'); assert.match(cap.stdout, /run r1/);
  });
  it('sources youtube / summarize / transform / context-level hit the right paths', async () => {
    let r = await run(['notebooks', 'sources', 'youtube', 'n1', '--url', 'https://youtu.be/x']);
    assert.match(r.last.path, /\/sources\/youtube$/); assert.deepEqual(r.last.body, { url: 'https://youtu.be/x' });
    r = await run(['notebooks', 'sources', 'summarize', 'n1', 's/1']);
    assert.match(r.last.path, /\/sources\/s%2F1\/summarize$/); assert.equal(r.last.method, 'POST');
    r = await run(['notebooks', 'sources', 'transform', 'n1', 's1', '--template', 'faq']);
    assert.match(r.last.path, /\/sources\/s1\/transform$/); assert.deepEqual(r.last.body, { templateId: 'faq' });
    r = await run(['notebooks', 'sources', 'context-level', 'n1', 's1', '--level', 'excluded']);
    assert.equal(r.last.method, 'PUT'); assert.match(r.last.path, /\/sources\/s1\/context-level$/); assert.deepEqual(r.last.body, { level: 'excluded' });
    r = await run(['notebooks', 'sources', 'context-level', 'n1', 's1', '--level', 'bogus']);
    assert.equal(r.code, 2); assert.equal(r.calls.length, 0);
  });
  it('sources list + transformations + templates are GETs; --json passes through', async () => {
    let r = await run(['--json', 'notebooks', 'sources', 'list', 'n1'], () => json({ sources: [{ id: 's1' }] }));
    assert.match(r.last.path, /\/notebooks\/n1\/sources$/); assert.deepEqual(JSON.parse(r.cap.stdout), { sources: [{ id: 's1' }] });
    r = await run(['notebooks', 'transformations', 'n1']); assert.match(r.last.path, /\/notebooks\/n1\/transformations$/);
    r = await run(['notebooks', 'transformations', 'templates', 'n1'], () => json({ templates: [{ id: 'faq', label: 'FAQ' }] }));
    assert.match(r.last.path, /\/transformations\/templates$/); assert.match(r.cap.stdout, /faq\s+FAQ/);
  });
  it('chat prints the conversation id; search posts query + topK', async () => {
    let r = await run(['notebooks', 'chat', 'n1'], () => json({ conversationId: 'conv_9' }));
    assert.equal(r.last.method, 'POST'); assert.match(r.last.path, /\/notebooks\/n1\/chat$/); assert.match(r.cap.stdout, /conv_9/);
    r = await run(['notebooks', 'search', 'n1', 'pricing', 'objections', '--top-k', '3'], () => json({ hits: [{ score: 0.9, title: 'Doc', text: 'x' }], citations: [] }));
    assert.deepEqual(r.last.body, { query: 'pricing objections', topK: 3 }); assert.match(r.cap.stdout, /0\.900\s+Doc/);
  });
  it('delete requires --yes and DELETEs', async () => {
    let r = await run(['notebooks', 'delete', 'n1']); assert.equal(r.code, 2); assert.equal(r.calls.length, 0);
    r = await run(['notebooks', 'delete', 'n1', '--yes']); assert.equal(r.last.method, 'DELETE'); assert.match(r.last.path, /\/notebooks\/n1$/);
  });
  it('a 403 exits 4 with a legible message', async () => {
    const r = await run(['notebooks', 'sources', 'list', 'n1'], () => json({ message: 'Missing required scope: workspace:read' }, 403));
    assert.equal(r.code, 4); assert.match(r.cap.stderr, /HTTP 403: Missing required scope/);
  });
});

describe('podcasts (b4)', () => {
  it('shows list requires --org and sends ?orgId=', async () => {
    let r = await run(['podcasts', 'shows', 'list']); assert.equal(r.code, 2); assert.equal(r.calls.length, 0);
    r = await run(['podcasts', 'shows', 'list', '--org', 'o1'], () => json({ shows: [{ id: 'sh1', title: 'T', slug: 't', published: true }], canWrite: true }));
    assert.match(r.last.path, /\/podcasts\/shows$/); assert.equal(r.last.search, '?orgId=o1'); assert.match(r.cap.stdout, /sh1\s+T\s+t\s+true/);
  });
  it('shows create sends mapped fields; update PUTs a partial (host merges)', async () => {
    let r = await run(['podcasts', 'shows', 'create', '--org', 'o1', '--title', 'T', '--author', 'A', '--language', 'fr', '--explicit'], () => json({ show: { id: 'sh1' } }));
    assert.equal(r.last.method, 'POST'); assert.deepEqual(r.last.body, { title: 'T', author: 'A', languageCode: 'fr', explicit: true, orgId: 'o1' });
    r = await run(['podcasts', 'shows', 'update', 'sh1', '--body', '{"description":"d"}', '--spotify-url', 'https://open.spotify.com/x']);
    assert.equal(r.last.method, 'PUT'); assert.match(r.last.path, /\/shows\/sh1$/);
    assert.deepEqual(r.last.body, { description: 'd', spotifyUrl: 'https://open.spotify.com/x' });
  });
  it('shows get/publish/unpublish/delete', async () => {
    let r = await run(['podcasts', 'shows', 'get', 'sh1']); assert.match(r.last.path, /\/shows\/sh1$/); assert.equal(r.last.method, 'GET');
    r = await run(['podcasts', 'shows', 'publish', 'sh1']); assert.match(r.last.path, /\/shows\/sh1\/publish$/); assert.equal(r.last.method, 'POST');
    r = await run(['podcasts', 'shows', 'unpublish', 'sh1']); assert.match(r.last.path, /\/shows\/sh1\/unpublish$/);
    r = await run(['podcasts', 'shows', 'delete', 'sh1', '--yes']); assert.equal(r.last.method, 'DELETE');
  });
  it('episodes publish sends showId + overrides; unpublish; get', async () => {
    let r = await run(['podcasts', 'episodes', 'publish', 'e1', '--show', 'sh1', '--clear-description', '--not-explicit'], () => json({ episode: { id: 'e1', showId: 'sh1' } }));
    assert.match(r.last.path, /\/episodes\/e1\/publish$/); assert.deepEqual(r.last.body, { showId: 'sh1', descriptionOverride: null, explicitOverride: false });
    assert.match(r.cap.stdout, /on show sh1/);
    r = await run(['podcasts', 'episodes', 'unpublish', 'e1']); assert.match(r.last.path, /\/episodes\/e1\/unpublish$/);
    r = await run(['podcasts', 'episodes', 'get', 'e1']); assert.match(r.last.path, /\/episodes\/e1$/);
    r = await run(['podcasts', 'episodes', 'list', '--org', 'o1']); assert.equal(r.last.search, '?orgId=o1');
  });
  it('speaker-profiles create parses --speakers JSON; list/delete', async () => {
    let r = await run(['podcasts', 'speaker-profiles', 'create', '--org', 'o1', '--name', 'Duo', '--speakers', '[{"name":"A","voiceId":"v1"}]'], () => json({ profile: { id: 'sp1' } }));
    assert.match(r.last.path, /\/podcasts\/speaker-profiles$/);
    assert.deepEqual(r.last.body, { orgId: 'o1', name: 'Duo', speakers: [{ name: 'A', voiceId: 'v1' }] });
    assert.match(r.cap.stdout, /sp1/);
    r = await run(['podcasts', 'speaker-profiles', 'create', '--org', 'o1', '--name', 'Duo']); assert.equal(r.code, 2); assert.match(r.cap.stderr, /speakers/);
    r = await run(['podcasts', 'speaker-profiles', 'list', '--org', 'o1'], () => json({ profiles: [{ id: 'sp1', name: 'Duo', provider: 'minimax', speakers: [{ name: 'A' }, { name: 'B' }] }] }));
    assert.match(r.cap.stdout, /sp1\s+Duo\s+minimax\s+A, B/);
    r = await run(['podcasts', 'speaker-profiles', 'delete', 'sp1', '--yes']); assert.equal(r.last.method, 'DELETE'); assert.match(r.last.path, /\/speaker-profiles\/sp1$/);
  });
  it('episode-profiles create maps fields; list sends orgId; delete', async () => {
    let r = await run(['podcasts', 'episode-profiles', 'create', '--org', 'o1', '--name', 'W', '--speaker-profile', 'sp1', '--segment-count', '4', '--language', 'en']);
    assert.deepEqual(r.last.body, { orgId: 'o1', name: 'W', speakerProfileId: 'sp1', segmentCount: 4, languageCode: 'en' });
    r = await run(['--json', 'podcasts', 'episode-profiles', 'list', '--org', 'o1'], () => json({ profiles: [] }));
    assert.equal(r.last.search, '?orgId=o1'); assert.deepEqual(JSON.parse(r.cap.stdout), { profiles: [] });
    r = await run(['podcasts', 'episode-profiles', 'delete', 'ep1', '--yes']); assert.match(r.last.path, /\/episode-profiles\/ep1$/);
  });
  it('a 403 exits 4 with a legible message', async () => {
    const r = await run(['podcasts', 'shows', 'publish', 'sh1'], () => json({ message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(r.code, 4); assert.match(r.cap.stderr, /HTTP 403: Missing required scope: workspace:write/);
  });
});

describe('knowledge-sync', () => {
  it('browse GETs with orgId/connectionId/folderId', async () => {
    const r = await run(['knowledge-sync', 'browse', '--org', 'o1', '--connection', 'c1', '--folder', 'f1'], () => json({ folders: [{ id: 'f2', name: 'Docs' }], folderId: 'f1' }));
    assert.match(r.last.path, /\/knowledge-sync\/browse$/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(r.last.search)), { orgId: 'o1', connectionId: 'c1', folderId: 'f1' });
    assert.match(r.cap.stdout, /f2\s+Docs/);
  });
  it('create maps flags to the body (includeMedia opt-out only)', async () => {
    const r = await run(['knowledge-sync', 'create', '--org', 'o1', '--connection', 'c1', '--collection', 'col1', '--folder', 'root', '--cadence', 'daily', '--no-media']);
    assert.equal(r.last.method, 'POST');
    assert.deepEqual(r.last.body, { orgId: 'o1', connectionId: 'c1', collectionId: 'col1', externalFolderId: 'root', cadence: 'daily', includeMedia: false });
  });
  it('get / update(PATCH) / pause / resume / sync / delete', async () => {
    let r = await run(['knowledge-sync', 'get', 'ks1']); assert.equal(r.last.method, 'GET'); assert.match(r.last.path, /\/knowledge-sync\/ks1$/);
    r = await run(['knowledge-sync', 'update', 'ks1', '--no-media']); assert.equal(r.last.method, 'PATCH'); assert.deepEqual(r.last.body, { includeMedia: false });
    r = await run(['knowledge-sync', 'pause', 'ks1']); assert.match(r.last.path, /\/ks1\/pause$/); assert.equal(r.last.method, 'POST');
    r = await run(['knowledge-sync', 'resume', 'ks1']); assert.match(r.last.path, /\/ks1\/resume$/);
    r = await run(['knowledge-sync', 'sync', 'ks1'], () => json({ result: { added: 2, updated: 1 }, source: {} }));
    assert.match(r.last.path, /\/ks1\/sync$/); assert.match(r.cap.stdout, /added=2 updated=1/);
    r = await run(['knowledge-sync', 'delete', 'ks1']); assert.equal(r.code, 2);
    r = await run(['knowledge-sync', 'delete', 'ks1', '--yes']); assert.equal(r.last.method, 'DELETE');
  });
  it('list requires --org; --json passes through', async () => {
    let r = await run(['knowledge-sync', 'list']); assert.equal(r.code, 2);
    r = await run(['--json', 'knowledge-sync', 'list', '--org', 'o1'], () => json({ sources: [{ id: 'ks1' }] }));
    assert.equal(r.last.search, '?orgId=o1'); assert.deepEqual(JSON.parse(r.cap.stdout), { sources: [{ id: 'ks1' }] });
  });
  it('a 403 exits 4 with a legible message', async () => {
    const r = await run(['knowledge-sync', 'sync', 'ks1'], () => json({ message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(r.code, 4); assert.match(r.cap.stderr, /HTTP 403/);
  });
});
