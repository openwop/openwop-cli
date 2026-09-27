// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// Drift guard for the embedded v2 path-template list (src/protocol.ts,
// V2_PATH_TEMPLATES). The fixture is the path set of the corpus's
// spec/v2/path-manifest.json, checked in so this runs without ../openwop.
// Refresh BOTH with: node scripts/sync-path-manifest.mjs <openwop-corpus>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { V2_PATH_TEMPLATES, V2_MANIFEST_OMITTED, hostRootsFrom, hostRootFor } from '../dist/cli.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v2-path-manifest-paths.json', import.meta.url), 'utf8'));

describe('v2 path manifest', () => {
  it('the embedded templates + the deliberate omissions equal the manifest path set exactly', () => {
    const embedded = [...V2_PATH_TEMPLATES, ...V2_MANIFEST_OMITTED].sort();
    assert.deepEqual(embedded, [...fixture.paths].sort(), 'run scripts/sync-path-manifest.mjs against the corpus');
  });

  it('no path is both embedded and omitted, and nothing is embedded twice', () => {
    assert.equal(new Set(V2_PATH_TEMPLATES).size, V2_PATH_TEMPLATES.length);
    for (const p of V2_MANIFEST_OMITTED) assert.ok(!V2_PATH_TEMPLATES.includes(p), p);
  });

  it('the fixture is at least the 45-path corpus (webhook dead-letters + rotate-secret included)', () => {
    assert.ok(fixture.paths.length >= 45, String(fixture.paths.length));
    assert.ok(V2_PATH_TEMPLATES.includes('/webhooks/{webhookId}/dead-letters'));
    assert.ok(V2_PATH_TEMPLATES.includes('/webhooks/{webhookId}/rotate-secret'));
  });
});

describe('host-proprietary roots (versioning.md §5)', () => {
  it('reads { root, twin } objects from extensions and ignores everything else', () => {
    assert.deepEqual(
      hostRootsFrom({
        'openwop-app.host': { root: '/host/openwop-app/', twin: '/v1/host/openwop-app/' },
        'openwop-app.notes': 'text',
        'x.bad-root': { root: '/v1/host/x/' },
        'y.bad-twin': { root: '/host/y/', twin: '/v2/host/y/' },
      }),
      { '/v1/host/openwop-app/': '/host/openwop-app/' },
    );
    assert.deepEqual(hostRootsFrom(undefined), {});
    assert.deepEqual(hostRootsFrom(['x']), {});
  });

  it('rewrites only paths under an advertised twin, keeping the tail and query', () => {
    const roots = { '/v1/host/openwop-app/': '/host/openwop-app/' };
    assert.equal(hostRootFor('/v1/host/openwop-app/orgs?limit=5', roots), '/host/openwop-app/orgs?limit=5');
    assert.equal(hostRootFor('/v1/host/openwop-apps/orgs', roots), null);
    assert.equal(hostRootFor('/v1/host/workspace/files', roots), null);
    assert.equal(hostRootFor('/v1/runs', roots), null);
  });
});
