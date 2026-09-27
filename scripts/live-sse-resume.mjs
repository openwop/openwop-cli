#!/usr/bin/env node
/**
 * Live check: does `openwop runs watch` resume a REAL run's event stream after
 * the connection breaks? (stdlib only; run after `npm run build`.)
 *
 *   node scripts/live-sse-resume.mjs [--upstream <url> | --base-url <url>] [--mode drop|stall]
 *                                    [--delay-ms 6000] [--workflow conformance-delay]
 *
 * 1. Mints an anonymous session on the upstream by starting a run of a
 *    workflow that waits `--delay-ms` between its node-started and
 *    node-completed events (the reference host serves `conformance-delay` to
 *    anonymous visitors on /v1).
 * 2. Starts a local proxy in front of the upstream that injects that session
 *    cookie and strips any Authorization header (so the CLI reads the
 *    anonymous run it cannot otherwise address), and breaks the FIRST
 *    events stream right after the first chunk that completes an event:
 *      drop  — destroys the socket (what a network drop looks like to a client)
 *      stall — stops forwarding but keeps the socket open (a half-open
 *              connection; exercises the CLI's idle watchdog)
 * 3. Runs the built CLI's `runs watch --json` through the proxy and asserts:
 *    the reconnect carried `Last-Event-ID` = the last event id delivered before the break, every
 *    sequence printed exactly once, the terminal event arrived, exit 0.
 *
 * The upstream must be an origin that streams (NOT a buffering CDN front door):
 * --upstream, else the `streamBase` advertised by --base-url (default
 * https://app.openwop.dev/api), else the reference host's Cloud Run origin. No credential of yours
 * is used or printed.
 */
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
// The upstream must stream (not a buffering CDN front door). Precedence: --upstream,
// else the `streamBase` the host at --base-url advertises (openwop-app ADR 0761),
// else the reference host's Cloud Run origin (known to stream).
const REFERENCE_STREAM_ORIGIN = 'https://openwop-app-backend-89896419173.us-central1.run.app';
async function advertisedStreamBase(base) {
  try {
    const res = await fetch(new URL('.well-known/openwop', base.endsWith('/') ? base : `${base}/`), { headers: { accept: 'application/json', 'openwop-version': '2' } });
    const doc = await res.json();
    for (const v of Object.values(doc?.extensions ?? {})) if (typeof v?.streamBase === 'string' && v.streamBase.startsWith('https://')) return v.streamBase;
  } catch { /* fall through */ }
  return undefined;
}
const upstream = new URL(args.upstream ?? (await advertisedStreamBase(args['base-url'] ?? 'https://app.openwop.dev/api')) ?? REFERENCE_STREAM_ORIGIN);
const mode = args.mode ?? 'drop';
const delayMs = Number(args['delay-ms'] ?? 6000);
const workflowId = args.workflow ?? 'conformance-delay';
if (!['drop', 'stall'].includes(mode)) { console.error('--mode must be drop|stall'); process.exit(2); }

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// 1. Mint an anonymous session + a slow run.
const created = await fetch(new URL('/v1/runs', upstream), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workflowId, inputs: { delayMs } }),
});
const setCookie = created.headers.getSetCookie?.() ?? [];
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
const run = await created.json().catch(() => ({}));
if (!created.ok || !run.runId) fail(`could not start ${workflowId} (HTTP ${created.status}): ${JSON.stringify(run).slice(0, 200)}`);
if (!cookie) fail('upstream set no session cookie');
console.log(`run ${run.runId} (${workflowId}, delayMs=${delayMs}) — mode ${mode}`);

// 2. The proxy.
const eventsConnections = [];
const client = upstream.protocol === 'https:' ? https : http;
const proxy = http.createServer((req, res) => {
  const isEvents = /\/events(\?|$)/.test(req.url ?? '') && !/\/events\/poll/.test(req.url ?? '');
  const headers = { ...req.headers, host: upstream.host, cookie };
  delete headers.authorization;
  const index = isEvents ? eventsConnections.push({ lastEventId: req.headers['last-event-id'] }) - 1 : -1;
  const up = client.request({ protocol: upstream.protocol, host: upstream.hostname, port: upstream.port || undefined, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    if (index !== 0) { ur.pipe(res); return; }
    // The first events stream: forward until one complete frame carrying an id, then break it.
    let buffer = '';
    ur.on('data', (chunk) => {
      if (eventsConnections[0].broken) return;
      buffer += chunk.toString('utf8');
      const m = /(^|\n)id: *([^\n]+)\n[\s\S]*?\n\n/.exec(buffer);
      if (!m) { res.write(chunk); return; }
      eventsConnections[0].broken = true;
      // The id the CLI must resume from is the LAST complete frame forwarded
      // (one upstream chunk can carry several events).
      const complete = buffer.slice(0, buffer.lastIndexOf('\n\n') + 2);
      const ids = [...complete.matchAll(/(^|\n)id: *([^\n]+)/g)].map((x) => x[2].trim());
      eventsConnections[0].lastForwardedId = ids[ids.length - 1];
      // Deliver the first event, and only then break the connection: cutting
      // in the same tick can discard the bytes still in flight, which would
      // test "resume with no id" instead of "resume after an id".
      res.write(chunk, () => setTimeout(() => {
        if (mode === 'drop') { res.socket?.destroy(); ur.destroy(); }
        // stall: keep the client socket open and forward nothing more.
      }, 250));
    });
    ur.on('end', () => { if (!eventsConnections[0].broken) res.end(); });
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const port = proxy.address().port;

// 3. The CLI.
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'openwop.js');
const child = spawn(process.execPath, [cli, '--json', 'runs', 'watch', run.runId, '--base-url', `http://127.0.0.1:${port}`, ...(mode === 'stall' ? ['--idle-timeout-ms', '3000'] : [])], { env: { ...process.env, OPENWOP_STREAM_BASE_URL: '' } });
let stdout = ''; let stderr = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });
const code = await new Promise((r) => { const t = setTimeout(() => { child.kill(); r('timeout'); }, delayMs + 60000); child.on('exit', (c) => { clearTimeout(t); r(c); }); });
proxy.close();

const events = stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const seqs = events.map((e) => e.sequence).filter((s) => typeof s === 'number');
console.log(`exit=${code} events=${JSON.stringify(events.map((e) => `${e.sequence}:${e.type}`))}`);
console.log(`events connections: ${JSON.stringify(eventsConnections)}`);
if (code !== 0) fail(`CLI exited ${code}: ${stderr.slice(0, 400)}`);
if (!eventsConnections[0]?.broken) fail('the first events stream was never broken (the run finished before an event arrived?)');
if (eventsConnections.length < 2) fail('the CLI never reconnected');
if (String(eventsConnections[1].lastEventId) !== String(eventsConnections[0].lastForwardedId)) fail(`reconnect Last-Event-ID ${eventsConnections[1].lastEventId} ≠ last event id delivered before the break (${eventsConnections[0].lastForwardedId})`);
if (new Set(seqs).size !== seqs.length) fail(`duplicate sequences printed: ${seqs.join(',')}`);
if (!events.some((e) => /^run\.(completed|failed|cancelled)$/.test(e.type))) fail('no terminal event printed');
console.log(`PASS (${mode}): resumed with Last-Event-ID ${eventsConnections[1].lastEventId}; ${seqs.length} events, no duplicates.`);
