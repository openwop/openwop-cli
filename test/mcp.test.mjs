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

// A JSON-RPC mount mock: asserts the envelope, dispatches on method, returns `result`.
function rpcMock(handler) {
  return async (url, init) => {
    assert.match(new URL(url).pathname, /\/v1\/host\/sample\/mcp$/);
    assert.equal(init.method, 'POST');
    const req = JSON.parse(init.body);
    assert.equal(req.jsonrpc, '2.0');
    assert.ok(req.method, 'method present');
    return jsonResponse({ jsonrpc: '2.0', id: req.id, result: handler(req) });
  };
}

describe('mcp info', () => {
  it('renders serverInfo + protocolVersion + capabilities', async () => {
    const cap = capture();
    const fetchImpl = rpcMock((req) => {
      assert.equal(req.method, 'initialize');
      return {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'openwop-workflow-engine-sample', version: '0.1.0' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      };
    });
    const code = await runCli(['mcp', 'info'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /server: openwop-workflow-engine-sample 0\.1\.0/);
    assert.match(cap.stdout, /protocolVersion: 2025-06-18/);
    assert.match(cap.stdout, /capabilities: tools, resources, prompts/);
  });

  it('emits the raw JSON-RPC result under --json', async () => {
    const cap = capture();
    const fetchImpl = rpcMock(() => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'x', version: '1' }, capabilities: {} }));
    const code = await runCli(['--json', 'mcp', 'info'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(JSON.parse(cap.stdout).protocolVersion, '2025-06-18');
  });
});

describe('mcp ping', () => {
  it('reports the mount reachable', async () => {
    const cap = capture();
    const fetchImpl = rpcMock((req) => { assert.equal(req.method, 'ping'); return {}; });
    const code = await runCli(['mcp', 'ping'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /ping ok/);
  });
});

describe('mcp tools', () => {
  it('lists exposed tools as a table', async () => {
    const cap = capture();
    const fetchImpl = rpcMock((req) => {
      assert.equal(req.method, 'tools/list');
      return { tools: [{ name: 'sample.demo.uppercase', description: 'Uppercase text', inputSchema: { type: 'object' } }] };
    });
    const code = await runCli(['mcp', 'tools', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /sample\.demo\.uppercase\s+Uppercase text/);
  });

  it('calls a tool with parsed --args-json and prints the text content', async () => {
    const cap = capture();
    const fetchImpl = rpcMock((req) => {
      assert.equal(req.method, 'tools/call');
      assert.deepEqual(req.params, { name: 'sample.demo.uppercase', arguments: { text: 'hi' } });
      return { content: [{ type: 'text', text: 'HI' }], isError: false };
    });
    const code = await runCli(['mcp', 'tools', 'call', 'sample.demo.uppercase', '--args-json', '{"text":"hi"}'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /^HI$/m);
  });

  it('exits 1 when the tool result isError', async () => {
    const cap = capture();
    const fetchImpl = rpcMock(() => ({ content: [{ type: 'text', text: 'run failed: x' }], isError: true }));
    const code = await runCli(['mcp', 'tools', 'call', 'sample.demo.boom'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /run failed: x/);
  });

  it('rejects malformed --args-json locally (exit 2, no request)', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = async () => { called = true; return jsonResponse({}); };
    const code = await runCli(['mcp', 'tools', 'call', 't', '--args-json', '{bad'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /--args-json must be valid JSON/);
  });
});

describe('mcp resources', () => {
  it('lists resources and reads one by uri', async () => {
    const listCap = capture();
    const listFetch = rpcMock((req) => {
      assert.equal(req.method, 'resources/list');
      return { resources: [{ uri: 'mcp://sample/readme', name: 'readme', mimeType: 'text/plain' }] };
    });
    let code = await runCli(['mcp', 'resources'], opts(listFetch, listCap));
    assert.equal(code, 0, listCap.stderr);
    assert.match(listCap.stdout, /mcp:\/\/sample\/readme\s+readme\s+text\/plain/);

    const readCap = capture();
    const readFetch = rpcMock((req) => {
      assert.equal(req.method, 'resources/read');
      assert.deepEqual(req.params, { uri: 'mcp://sample/readme' });
      return { contents: [{ uri: 'mcp://sample/readme', text: 'hello', mimeType: 'text/plain' }] };
    });
    code = await runCli(['mcp', 'resources', 'read', 'mcp://sample/readme'], opts(readFetch, readCap));
    assert.equal(code, 0, readCap.stderr);
    assert.match(readCap.stdout, /^hello$/m);
  });
});

describe('mcp prompts', () => {
  it('lists prompts and gets one rendered', async () => {
    const listCap = capture();
    const listFetch = rpcMock((req) => {
      assert.equal(req.method, 'prompts/list');
      return { prompts: [{ name: 'greet', description: 'Greeting', arguments: [{ name: 'name' }] }] };
    });
    let code = await runCli(['mcp', 'prompts'], opts(listFetch, listCap));
    assert.equal(code, 0, listCap.stderr);
    assert.match(listCap.stdout, /greet\s+Greeting\s+1/);

    const getCap = capture();
    const getFetch = rpcMock((req) => {
      assert.equal(req.method, 'prompts/get');
      assert.deepEqual(req.params, { name: 'greet', arguments: { name: 'Ada' } });
      return { description: 'Greeting', messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }] };
    });
    code = await runCli(['mcp', 'prompts', 'get', 'greet', '--args-json', '{"name":"Ada"}'], opts(getFetch, getCap));
    assert.equal(code, 0, getCap.stderr);
    assert.match(getCap.stdout, /\[user\] Hello Ada/);
  });
});

describe('mcp capability honesty', () => {
  it('fails closed legibly when the mount is not exposed (404)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'not found' }, 404);
    const code = await runCli(['mcp', 'info'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /MCP server mount not available/);
  });

  it('surfaces a JSON-RPC error with the host message and a contract exit code', async () => {
    const cap = capture();
    // -32601 method-not-found → usage/contract error → exit 2.
    const fetchImpl = async (url, init) => {
      const req = JSON.parse(init.body);
      return jsonResponse({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: "method 'tools/call' not implemented" } });
    };
    const code = await runCli(['mcp', 'tools', 'call', 't'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /MCP error -32601/);
  });
});
