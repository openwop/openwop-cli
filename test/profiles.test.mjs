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

const SAMPLE = {
  userId: 'user_1', displayName: 'Ada', jobTitle: 'Staff Eng', department: 'Platform',
  bio: 'builds things', completeness: 70, emailVerified: true,
  skills: [{ name: 'TypeScript', proficiency: 5, endorsements: ['u2', 'u3'] }],
  availability: { status: 'busy', timezone: 'Europe/London', hoursPerWeek: 32 },
  contact: { location: 'London', links: [{ label: 'site', url: 'https://x.dev' }] },
  equipment: ['laptop'], interests: ['rust'], workflows: ['wf_1'], pinnedAgentIds: ['r_9'],
  portfolioAssetTokens: ['tok_a'], avatarAssetToken: 'tok_av',
};

describe('profiles command', () => {
  it('shows your own profile (me → GET /me)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/profiles\/me$/);
      return jsonResponse(SAMPLE);
    };
    const code = await runCli(['profiles', 'me'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user: Ada \(user_1\)/);
    assert.match(cap.stdout, /skills: TypeScript\(5\) \+2/);
    assert.match(cap.stdout, /availability: busy · Europe\/London · 32h\/wk/);
  });

  it('get with no id hits /me; get <id> hits /:userId', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/profiles\/user_42$/);
      return jsonResponse({ ...SAMPLE, userId: 'user_42', displayName: 'Bob' });
    };
    const code = await runCli(['profiles', 'get', 'user_42'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user: Bob \(user_42\)/);
  });

  it('emits raw JSON with --json', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'get', 'user_1', '--json'], opts(async () => jsonResponse(SAMPLE), cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout).userId, 'user_1');
  });

  it('lists the tenant profile directory as a table', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/profiles$/);
      return jsonResponse({ profiles: [SAMPLE] });
    };
    const code = await runCli(['profiles', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /user_1\s+Ada\s+Staff Eng \/ Platform/);
  });

  it('reports an empty directory', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'list'], opts(async () => jsonResponse({ profiles: [] }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No profiles in this tenant/);
  });

  it('edits self via PATCH /me', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.match(new URL(url).pathname, /\/profiles\/me$/);
      assert.deepEqual(JSON.parse(init.body), { jobTitle: 'Staff Engineer', availability: { status: 'busy', timezone: 'Europe/London' } });
      return jsonResponse({ ...SAMPLE, jobTitle: 'Staff Engineer' });
    };
    const code = await runCli(
      ['profiles', 'edit', '--job-title', 'Staff Engineer', '--availability-status', 'busy', '--timezone', 'Europe/London'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Updated your profile/);
  });

  it('rejects an invalid --availability-status (no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['profiles', 'edit', '--availability-status', 'sleepy'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
  });

  it('errors when edit has nothing to change', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'edit'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
  });

  it('sets skills via PUT /me/skills', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.match(new URL(url).pathname, /\/profiles\/me\/skills$/);
      assert.deepEqual(JSON.parse(init.body), { skills: [{ name: 'TypeScript', proficiency: 5 }, { name: 'Rust', proficiency: 3 }] });
      return jsonResponse(SAMPLE);
    };
    const code = await runCli(['profiles', 'skills', 'set', '--skill', 'TypeScript=5', '--skill', 'Rust=3'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Set 2 skill\(s\)/);
  });

  it('rejects a skill proficiency outside 1..5', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'skills', 'set', '--skill', 'TypeScript=9'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
  });

  it('endorses a peer skill via POST', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/profiles\/user_42\/skills\/TypeScript\/endorse$/);
      return jsonResponse(SAMPLE);
    };
    const code = await runCli(['profiles', 'endorse', 'user_42', 'TypeScript'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Endorsed TypeScript on user_42/);
  });

  it('unendorse hits DELETE', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'DELETE');
      assert.match(new URL(url).pathname, /\/skills\/TypeScript\/endorse$/);
      return jsonResponse(SAMPLE);
    };
    const code = await runCli(['profiles', 'unendorse', 'user_42', 'TypeScript'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Removed endorsement for TypeScript on user_42/);
  });

  it('pins an agent via PUT /me/pinned-agents/:rosterId', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.match(new URL(url).pathname, /\/profiles\/me\/pinned-agents\/r_123$/);
      return jsonResponse(SAMPLE);
    };
    const code = await runCli(['profiles', 'pin', 'r_123'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Pinned agent r_123/);
  });

  it('adds a portfolio asset via POST', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/profiles\/me\/portfolio$/);
      assert.deepEqual(JSON.parse(init.body), { token: 'tok_x' });
      return jsonResponse(SAMPLE, 201);
    };
    const code = await runCli(['profiles', 'portfolio', 'add', '--token', 'tok_x'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Added portfolio asset/);
  });

  it('shows the activity feed with query params', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      const u = new URL(url);
      assert.match(u.pathname, /\/profiles\/me\/activity$/);
      assert.equal(u.searchParams.get('limit'), '10');
      assert.equal(u.searchParams.get('status'), 'failed');
      return jsonResponse({ items: [{ runId: 'r1', workflowId: 'wf', status: 'failed', createdAt: '2026-06-12' }], truncated: false });
    };
    const code = await runCli(['profiles', 'activity', '--limit', '10', '--status', 'failed'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /r1\s+wf\s+failed/);
  });

  it('fails closed when not signed in (401)', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'me'], opts(async () => jsonResponse({ message: 'unauth' }, 401), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /durable signed-in account/);
  });

  it('maps 404 on get <id> to a legible not-found', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'get', 'ghost'], opts(async () => jsonResponse({ message: 'Profile not found.' }, 404), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /Profile not found: ghost/);
  });

  it('rejects an unknown subcommand', async () => {
    const cap = capture();
    const code = await runCli(['profiles', 'bogus'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unknown profiles command: bogus/);
  });
});
