// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// `openwop packs` against a v2 registry (spec/v2/core/packs.md §"The registry
// tree", §Signing, §"Version manifests"; RFC 0222 §B): every path comes from
// `.well-known/openwop-registry.json` `endpoints` (v2 preferred), signatures are
// `ed25519-canonical-json` over the in-tarball pack.json checked against the
// key's permittedNamespaces, and `latest` / a range never resolve a yanked
// version while an exact pin may. Plus the host-side v2 routing of `openapi`
// and `workspace` (src/protocol.ts V2_RENAMED / V2_SEAM_PREFIXES).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as ed25519Sign, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function tarGz(entries) {
  const header = (name, size) => {
    const buf = Buffer.alloc(512, 0);
    const oct = (n, len, off) => buf.write(n.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
    buf.write(name, 0, 100, 'ascii');
    oct(0o644, 8, 100); oct(0, 8, 108); oct(0, 8, 116); oct(size, 12, 124); oct(0, 12, 136);
    for (let i = 148; i < 156; i++) buf[i] = 0x20;
    buf[156] = 0x30;
    buf.write('ustar\0', 257, 6, 'ascii'); buf.write('00', 263, 2, 'ascii');
    let s = 0; for (let i = 0; i < 512; i++) s += buf[i];
    oct(s, 8, 148);
    return buf;
  };
  const chunks = [];
  for (const { name, content } of entries) {
    chunks.push(header(name, content.length), content);
    const pad = 512 - (content.length % 512);
    if (pad !== 512) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

const NAME = 'community.test.demo';
const KEY_ID = 'test-key-1';

/**
 * A v2 registry. Templates are deliberately NOT the /v2/... layout so a
 * client that constructs paths instead of resolving them through `endpoints`
 * gets 404s. `versions`: [{ version, yanked?, deprecated? }].
 */
function v2Registry({ versions = [{ version: '0.2.0' }], latest, key = {}, packJsonFor, withV2 = true } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const art = {};
  for (const v of versions) {
    const packJson = { name: NAME, version: v.version, kind: 'node', nodes: [], signing: { keyId: KEY_ID, scheme: 'ed25519-canonical-json' } };
    const bytes = Buffer.from(packJsonFor ? packJsonFor(packJson) : canonical(packJson), 'utf8');
    const sig = ed25519Sign(null, bytes, privateKey);
    const tgz = tarGz([{ name: 'keys/pack.json.sig', content: sig }, { name: 'pack.json', content: bytes }]);
    const integrity = 'sha256-' + createHash('sha256').update(tgz).digest('base64');
    art[v.version] = {
      tgz, sig,
      manifest: { ...packJson, integrity, yanked: Boolean(v.yanked), versionDeprecated: Boolean(v.deprecated), ...(v.manifest ?? {}) },
    };
  }
  const packIndex = {
    name: NAME, kind: 'node', latest: latest ?? versions[versions.length - 1].version,
    versions: versions.map((v) => ({ version: v.version, signingKeyId: KEY_ID, signingScheme: 'ed25519-canonical-json', integrity: art[v.version].manifest.integrity, yanked: Boolean(v.yanked), versionDeprecated: Boolean(v.deprecated) })),
  };
  const index = { packs: [{ name: NAME, kind: 'node', latestVersion: packIndex.latest, description: 'demo', license: 'MIT', typeIds: [], yanked: false, deprecated: false }] };
  const wellKnown = {
    endpoints: {
      registryIndex: '/old/index.json',
      packMetadata: '/old/p/{name}/index.json',
      versionManifest: '/old/p/{name}/-/{version}.json',
      versionTarball: '/old/p/{name}/-/{version}.tgz',
      versionSignature: '/old/p/{name}/-/{version}.sig',
      publicKey: '/k/{keyId}.pub',
      ...(withV2 ? { v2: {
        registryIndex: '/t2/index.json',
        packMetadata: '/t2/p/{name}/index.json',
        versionManifest: '/t2/p/{name}/-/{version}.json',
        versionTarball: '/t2/p/{name}/-/{version}.tgz',
        versionSignature: '/t2/p/{name}/-/{version}.sig',
      } } : {}),
    },
    signingKeys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKeyUrl: `/k/${KEY_ID}.pub`, permittedNamespaces: ['community.test.*'], status: 'active', ...key }],
  };
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const seen = [];
  const fetchImpl = async (url) => {
    const p = new URL(String(url)).pathname;
    seen.push(p);
    const enc = encodeURIComponent(NAME);
    const ok = (body) => new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), { status: 200 });
    if (p === '/.well-known/openwop-registry.json') return ok(wellKnown);
    const tree = withV2 ? '/t2' : '/old';
    if (p === `${tree}/index.json`) return ok(index);
    if (p === `${tree}/p/${enc}/index.json`) return ok(packIndex);
    const m = new RegExp(`^${tree}/p/${enc.replace(/\./g, '\\.')}/-/(.+)\\.(json|tgz|sig)$`).exec(p);
    if (m && art[m[1]]) return ok(m[2] === 'json' ? art[m[1]].manifest : m[2] === 'tgz' ? art[m[1]].tgz : art[m[1]].sig);
    if (p === `/k/${KEY_ID}.pub`) return ok(pubPem);
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  };
  return { fetchImpl, seen, art, packIndex, wellKnown };
}

async function packs(argv, reg) {
  const cap = capture();
  const code = await runCli(['packs', ...argv, '--registry-url', 'http://registry.local'], {
    io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
  });
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

describe('packs — registry paths come from .well-known endpoints (v2 preferred)', () => {
  it('search reads endpoints.v2.registryIndex, not a constructed /v1 or /v2 path', async () => {
    const reg = v2Registry();
    const cap = capture();
    const code = await runCli(['--json', 'packs', 'search', '--registry-url', 'http://registry.local'], {
      io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
    });
    assert.equal(code, 0);
    const out = JSON.parse(cap.stdout);
    assert.equal(out.tree, 'v2');
    assert.equal(out.total, 1);
    assert.ok(reg.seen.includes('/t2/index.json'));
    assert.ok(!reg.seen.some((p) => p.startsWith('/v1/') || p.startsWith('/v2/')));
  });

  it('info reads endpoints.v2.packMetadata and reports the tree', async () => {
    const reg = v2Registry();
    const r = await packs(['info', NAME], reg);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Tree:\s+v2/);
    assert.ok(reg.seen.includes(`/t2/p/${NAME}/index.json`));
  });

  it('falls back to the v1 templates only when the registry names no v2 tree', async () => {
    const reg = v2Registry({ withV2: false });
    const cap = capture();
    const code = await runCli(['--json', 'packs', 'search', '--registry-url', 'http://registry.local'], {
      io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(cap.stdout).tree, 'v1');
    assert.ok(reg.seen.includes('/old/index.json'));
  });

  it('--tree v2 against a registry with no v2 tree fails closed (exit 1)', async () => {
    const reg = v2Registry({ withV2: false });
    const r = await packs(['search', '--tree', 'v2'], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /names no v2 tree/);
  });
});

describe('packs install — v2 signature (ed25519-canonical-json)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'openwop-packs-v2-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('verifies the detached .sig over the in-tarball pack.json under the listed key', async () => {
    const reg = v2Registry();
    const cap = capture();
    const code = await runCli(['--json', 'packs', 'install', `${NAME}@0.2.0`, '--dir', tmp, '--registry-url', 'http://registry.local'], {
      io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
    });
    assert.equal(code, 0, cap.stderr);
    const out = JSON.parse(cap.stdout);
    assert.equal(out.tree, 'v2');
    assert.equal(out.signature, `verified (keyId=${KEY_ID}, scheme=ed25519-canonical-json)`);
    assert.equal(readFileSync(join(tmp, NAME, '0.2.0', '0.2.0.tgz')).length, reg.art['0.2.0'].tgz.length);
  });

  it('refuses a key whose permittedNamespaces do not cover the pack', async () => {
    const reg = v2Registry({ key: { permittedNamespaces: ['vendor.other.*', 'community.test'] } });
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pack_signature_invalid.*not permitted to sign community\.test\.demo/);
  });

  it('refuses a keyId the registry does not list', async () => {
    const reg = v2Registry({ key: { keyId: 'someone-else' } });
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not listed in the registry's signingKeys/);
  });

  it('still verifies a version signed by a key that is no longer active', async () => {
    const reg = v2Registry({ key: { status: 'rotated' } });
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /key status rotated/);
  });

  it('fails on a tampered signature', async () => {
    const reg = v2Registry();
    reg.art['0.2.0'].sig = Buffer.from(reg.art['0.2.0'].sig); reg.art['0.2.0'].sig[0] ^= 0xff;
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not verify under test-key-1/);
  });

  it('refuses a v1 signing block on the v2 tree', async () => {
    const reg = v2Registry({ versions: [{ version: '0.2.0', manifest: { signing: { method: 'manual', publicKeyRef: KEY_ID, keyId: KEY_ID, scheme: 'ed25519-canonical-json' } } }] });
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carries method, publicKeyRef/);
  });

  it('refuses a pack.json that is not canonical JSON even when the bytes are signed', async () => {
    const reg = v2Registry({ packJsonFor: (pj) => JSON.stringify(pj, null, 2) });
    const r = await packs(['install', `${NAME}@0.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not in canonical \(RFC 8785\) form/);
  });
});

describe('packs install — lifecycle (RFC 0222 §B)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'openwop-packs-life-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  const three = [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0', yanked: true }];

  it('latest skips a yanked version even when the index names it latest', async () => {
    const reg = v2Registry({ versions: three, latest: '1.2.0' });
    const cap = capture();
    const code = await runCli(['--json', 'packs', 'install', NAME, '--dir', tmp, '--registry-url', 'http://registry.local'], {
      io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
    });
    assert.equal(code, 0, cap.stderr);
    assert.equal(JSON.parse(cap.stdout).version, '1.1.0');
  });

  it('a range resolves the highest unyanked match', async () => {
    const reg = v2Registry({ versions: three });
    const cap = capture();
    const code = await runCli(['--json', 'packs', 'install', `${NAME}@^1.0.0`, '--dir', tmp, '--registry-url', 'http://registry.local'], {
      io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
    });
    assert.equal(code, 0, cap.stderr);
    assert.equal(JSON.parse(cap.stdout).version, '1.1.0');
  });

  it('a range that only a yanked version satisfies fails and says so', async () => {
    const reg = v2Registry({ versions: three });
    const r = await packs(['install', NAME, '--version', '>=1.2.0 <2.0.0', '--dir', tmp], reg);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No unyanked version .* satisfies ">=1\.2\.0 <2\.0\.0" \(a yanked version does; pin it exactly/);
  });

  it('an exact pin installs a yanked version with a warning', async () => {
    const reg = v2Registry({ versions: three });
    const r = await packs(['install', `${NAME}@1.2.0`, '--dir', tmp], reg);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: community\.test\.demo@1\.2\.0 is yanked/);
    assert.match(r.stdout, /Installed community\.test\.demo@1\.2\.0 \(v2 tree\)/);
  });

  it('a deprecated version installs with a warning', async () => {
    const reg = v2Registry({ versions: [{ version: '1.0.0', deprecated: true, manifest: { deprecationReason: 'use 2.x' } }] });
    const r = await packs(['install', `${NAME}@1.0.0`, '--dir', tmp], reg);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: community\.test\.demo@1\.0\.0 is deprecated \(use 2\.x\)/);
  });

  it('x-ranges and tilde ranges resolve too', async () => {
    const reg = v2Registry({ versions: [{ version: '1.0.0' }, { version: '1.0.5' }, { version: '1.1.0' }, { version: '2.0.0' }] });
    for (const [range, want] of [['1.x', '1.1.0'], ['~1.0.0', '1.0.5'], ['1.0.x', '1.0.5'], ['<2.0.0', '1.1.0'], ['^2', '2.0.0']]) {
      const cap = capture();
      const code = await runCli(['--json', 'packs', 'install', NAME, '--version', range, '--dir', tmp, '--no-verify', '--registry-url', 'http://registry.local'], {
        io: cap.io, fetchImpl: reg.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: {},
      });
      assert.equal(code, 0, `${range}: ${cap.stderr}`);
      assert.equal(JSON.parse(cap.stdout).version, want, range);
    }
  });
});

// ── host-side v2 routing: openapi + workspace ───────────────────────────────

const json = (body, status = 200) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function v2Host({ seams = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = init.headers ?? {};
    if (u.pathname === '/.well-known/openwop') {
      return json({ protocolVersions: ['1.11', '2.0'], ...(seams ? { conformance: { seamsProfile: 'openwop-conformance-seams-v2' } } : {}) });
    }
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, version: headers['openwop-version'] });
    if (u.pathname.endsWith('openapi.json')) return json({ openapi: '3.1.0', info: { title: 't', version: '2' }, paths: {} });
    if (u.pathname.endsWith('/workspace/files')) return json({ files: [] });
    return json({ content: 'x', etag: '"1"' });
  };
  return { fetchImpl, calls };
}

async function host(argv, h) {
  const cap = capture();
  const code = await runCli(['--base-url', 'http://h', ...argv], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k' } });
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

describe('openapi / workspace under protocol major 2', () => {
  it('openapi asks a v2 host for /openapi.json with OpenWOP-Version: 2.0', async () => {
    const h = v2Host();
    assert.equal((await host(['openapi'], h)).code, 0);
    assert.deepEqual(h.calls[0], { method: 'GET', path: '/openapi.json', search: '', version: '2.0' });
  });

  it('workspace goes to the seams-v2 twin when the host advertises the seams profile', async () => {
    const h = v2Host();
    assert.equal((await host(['workspace', 'list', '--prefix', 'notes/'], h)).code, 0);
    assert.equal((await host(['workspace', 'get', 'notes/a.md'], h)).code, 0);
    assert.deepEqual(h.calls.map((c) => [c.path, c.search, c.version]), [
      ['/conformance/seams/workspace/files', '?prefix=notes%2F', '2.0'],
      ['/conformance/seams/workspace/files/notes%2Fa.md', '', '2.0'],
    ]);
  });

  it('workspace keeps the v1 path on a v2 host that does not advertise the seams profile', async () => {
    const h = v2Host({ seams: false });
    assert.equal((await host(['workspace', 'list'], h)).code, 0);
    assert.deepEqual([h.calls[0].path, h.calls[0].version], ['/v1/host/workspace/files', undefined]);
  });

  it('ui-plugin --conformance-alias stays on the v1 seam path (no seams-v2 operation)', async () => {
    const h = v2Host();
    assert.equal((await host(['ui-plugin', 'rpc', '--method', 'm', '--conformance-alias'], h)).code, 0);
    assert.deepEqual([h.calls[0].path, h.calls[0].version], ['/v1/host/sample/ui-plugin/rpc', undefined]);
  });
});
