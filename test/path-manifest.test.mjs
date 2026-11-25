// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// Drift guard for the embedded v2 path-template list (src/protocol.ts,
// V2_PATH_TEMPLATES). The fixture is the path set of the corpus's
// spec/v2/path-manifest.json, checked in so this runs without ../openwop.
// Refresh BOTH with: node scripts/sync-path-manifest.mjs <openwop-corpus>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { V2_PATH_TEMPLATES, V2_MANIFEST_OMITTED, v2TemplatePattern, hostRootsFrom, isManifestPath, carriesVersionHeader } from '../dist/cli.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v2-path-manifest-paths.json', import.meta.url), 'utf8'));

describe('v2 path manifest', () => {
  it('the embedded templates + the deliberate omissions equal the manifest path set exactly', () => {
    const embedded = [...V2_PATH_TEMPLATES, ...V2_MANIFEST_OMITTED].sort();
    assert.deepEqual(embedded, [...fixture.paths].sort(), 'run scripts/sync-path-manifest.mjs against the corpus');
  });

  it('the fully-escaped template matcher is identical to the [.:]-escaping one it replaced, for every template', () => {
    // The old source escaped `.` and `:` only (`\:` is an identity escape, so it
    // matched exactly what `:` matches). The templates carry no other
    // metacharacter, so the full escape must leave each source unchanged bar `\:`.
    const legacy = (t) => `^${t.split('.').join('\\.').replace(/\{[A-Za-z]+\}/g, '[^/]+')}$`;
    for (const t of V2_PATH_TEMPLATES) {
      assert.match(t, /^[A-Za-z0-9/_.:{}-]+$/, t);
      assert.equal(v2TemplatePattern(t), legacy(t), t);
    }
    assert.equal(v2TemplatePattern('/a\\b/{id}(x)+'), '^/a\\\\b/[^/]+\\(x\\)\\+$', 'every metacharacter outside a placeholder is escaped');
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
  it('reads every extensions.<org>.<name>.root under /host/<org>/ and ignores everything else', () => {
    assert.deepEqual(
      hostRootsFrom({
        'openwop-app.host': { root: '/host/openwop-app/' },
        'openwop-app.notes': 'text',
        'x.no-slash': { root: '/host/x' },
        'y.not-host': { root: '/v2/host/y/' },
        'z.dup': { root: '/host/openwop-app/' },
      }),
      ['/host/openwop-app/', '/host/x/'],
    );
    assert.deepEqual(hostRootsFrom(undefined), []);
    assert.deepEqual(hostRootsFrom(['x']), []);
  });
});

describe('the v2 version header (versioning.md §1.3, §5)', () => {
  it('manifest operations match their templates, query ignored', () => {
    assert.equal(isManifestPath('/runs/acme~2Fr1/events/poll?afterSequence=3'), true);
    assert.equal(isManifestPath('/runs:bulk-cancel'), true);
    assert.equal(isManifestPath('/host/events'), true);
    assert.equal(isManifestPath('/host/openwop-app/orgs'), false);
  });

  it('every protocol path carries OpenWOP-Version; a host-proprietary /host/<org>/ route does not, unless the manifest names it', () => {
    for (const p of ['/runs', '/runs/r1/debug-bundle', '/prompts:render', '/conformance/seams/workspace/files', '/host/events', '/host/effect-seams']) {
      assert.equal(carriesVersionHeader(p), true, p);
    }
    for (const p of ['/host/openwop-app/orgs?limit=5', '/host/sample/ui-plugin/rpc']) assert.equal(carriesVersionHeader(p), false, p);
  });
});
