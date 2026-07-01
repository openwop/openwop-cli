// Run via `npm test` (builds dist/ first) — these import the esbuild bundle at ../dist/cli.js.
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function opts(fetchImpl, cap) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

const USER = {
  userId: 'user:abc', tenantId: 'default', principalId: 'oidc:sub1',
  email: 'a@b.dev', displayName: 'Ada', groups: ['eng', 'oncall'], source: 'oidc',
  status: 'active', createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z',
};

describe('users list/get', () => {
  it('lists users as a table', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/users\/users$/);
      return jsonResponse({ users: [USER] });
    };
    const code = await runCli(['users', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user:abc\s+oidc:sub1\s+Ada\s+oidc\s+active\s+2/);
  });

  it('gets one user as JSON', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/users\/users\/user%3Aabc$/);
      return jsonResponse(USER);
    };
    const code = await runCli(['--json', 'users', 'get', 'user:abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(JSON.parse(cap.stdout).principalId, 'oidc:sub1');
  });
});

describe('users create', () => {
  it('POSTs a new user with principalId + groups + source', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/users\/users$/);
      assert.deepEqual(JSON.parse(init.body), { principalId: 'oidc:sub1', email: 'a@b.dev', groups: ['eng'], source: 'oidc' });
      return jsonResponse({ ...USER, groups: ['eng'] }, 201);
    };
    const code = await runCli(
      ['users', 'create', '--principal', 'oidc:sub1', '--email', 'a@b.dev', '--group', 'eng', '--source', 'oidc'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Created user user:abc \(oidc:sub1\)/);
  });

  it('requires --principal (exit 2, no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['users', 'create', '--email', 'a@b.dev'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
  });

  it('rejects an unknown --source locally (exit 2)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['users', 'create', '--principal', 'p', '--source', 'ldap'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /--source must be one of/);
  });
});

describe('users update', () => {
  it('PATCHes group replacement + clears email with empty string', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { email: '', groups: ['eng', 'oncall'] });
      return jsonResponse({ ...USER, email: undefined, groups: ['eng', 'oncall'] });
    };
    const code = await runCli(['users', 'update', 'user:abc', '--email', '', '--group', 'eng', '--group', 'oncall'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Updated user user:abc/);
  });

  it('rejects an empty patch (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['users', 'update', 'user:abc'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Nothing to update/);
  });
});

describe('users lifecycle', () => {
  it('disables a user via POST .../disable', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/users\/users\/user%3Aabc\/disable$/);
      return jsonResponse({ ...USER, status: 'disabled' });
    };
    const code = await runCli(['users', 'disable', 'user:abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user:abc → disabled/);
  });

  it('enables a user via POST .../enable', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/users\/users\/user%3Aabc\/enable$/);
      return jsonResponse({ ...USER, status: 'active' });
    };
    const code = await runCli(['users', 'enable', 'user:abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user:abc → active/);
  });

  it('refuses delete without --yes (exit 2, no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['users', 'delete', 'user:abc'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /Refusing to delete/);
  });

  it('deletes with --yes (DELETE, 204)', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'DELETE');
      return new Response(null, { status: 204 });
    };
    const code = await runCli(['users', 'delete', 'user:abc', '--yes'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Deleted user user:abc/);
  });
});

describe('users me', () => {
  it('GETs the caller record', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.match(new URL(url).pathname, /\/users\/me$/);
      return jsonResponse(USER);
    };
    const code = await runCli(['users', 'me'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /principalId: oidc:sub1/);
  });

  it('PATCHes own display name when --display-name is given', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { displayName: 'Ada L.' });
      return jsonResponse({ ...USER, displayName: 'Ada L.' });
    };
    const code = await runCli(['users', 'me', '--display-name', 'Ada L.'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /displayName: Ada L\./);
  });

  it('surfaces a disabled account legibly (403 → exit 2, group self-handles)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'This account is disabled.' }, 403);
    const code = await runCli(['users', 'me'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /account is disabled/i);
  });
});

describe('users capability honesty', () => {
  it('fails closed legibly when the surface is not served (404 on collection)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'not found' }, 404);
    const code = await runCli(['users', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /does not serve the users surface/);
  });
});
