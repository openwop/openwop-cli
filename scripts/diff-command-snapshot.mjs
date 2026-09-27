#!/usr/bin/env node
/**
 * Mechanical diff of two command-behaviour snapshots
 * (test/fixtures/command-behaviour.json, written by scripts/snapshot-commands.mjs).
 *
 * Every recorded invocation is keyed by `group / command / variant` (plus each
 * group's `--help` and group-level errors) and every changed one is CLASSIFIED
 * by which recorded fields moved (argv, requests, stdout, stderr, exit) and by
 * what kind of invocation it is (`--json`, blank-number, help). A change to the
 * engine is then checked against an explicit profile instead of by eyeballing
 * a multi-megabyte diff:
 *
 *   node scripts/diff-command-snapshot.mjs <old.json> [new.json] [--expect <profile>]
 *
 * `new.json` defaults to the checked-in fixture. Profiles (exit 1 on any violation):
 *   additive       no invocation removed or changed; only new ones added
 *                  (temp-file paths in argv are ignored — they name fixtures, not behaviour)
 *   blank-number   only blank-number invocations (`--<number-flag>=`) change, and each
 *                  becomes a usage error: exit 2, no request sent, nothing on stdout
 *   presentation   the exit code, the requests sent and every `--json` stdout are
 *                  unchanged; only stderr, help text and human-mode stdout may move
 *
 * Without --expect it only prints the classification.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = ['argv', 'requests', 'stdout', 'stderr', 'exit'];

/** Map `group / key / variant` → recorded invocation. */
export function flatten(snap) {
  const out = new Map();
  for (const [group, entry] of Object.entries(snap.groups)) {
    out.set(`${group} / --help`, { ...entry.help, variant: 'group-help' });
    for (const [name, row] of Object.entries(entry.groupErrors ?? {})) out.set(`${group} / (group) / ${name}`, { ...row, variant: `group-${name}` });
    for (const [key, rows] of Object.entries(entry.commands)) {
      for (const row of rows) {
        const id = `${group} / ${key} / ${row.variant}`;
        if (out.has(id)) throw new Error(`duplicate invocation id: ${id}`);
        out.set(id, row);
      }
    }
  }
  return out;
}

const stripTmp = (argv) => argv.map((a) => a.replace(/<TMP>\/[^\s"]*/g, '<TMP>/…'));

function tags(row) {
  const t = [];
  if (row.argv.includes('--json')) t.push('json');
  if (/^blank/.test(row.variant)) t.push('blank-number');
  if (row.variant === 'sub-help' || row.variant === 'group-help') t.push('help');
  return t;
}

export function classify(oldSnap, newSnap) {
  const a = flatten(oldSnap);
  const b = flatten(newSnap);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [];
  for (const [id, before] of a) {
    const after = b.get(id);
    if (!after) continue;
    const moved = FIELDS.filter((f) => !isDeepStrictEqual(before[f], after[f]));
    if (moved.length) changed.push({ id, before, after, moved, tags: tags(before) });
  }
  return { total: { old: a.size, new: b.size }, added, removed, changed };
}

const PROFILES = {
  additive(c) {
    const bad = c.changed.filter((x) => {
      const moved = x.moved.filter((f) => f !== 'argv' || !isDeepStrictEqual(stripTmp(x.before.argv), stripTmp(x.after.argv)));
      return moved.length > 0;
    });
    return [...c.removed.map((id) => `removed: ${id}`), ...bad.map((x) => `changed (${x.moved.join(',')}): ${x.id}`)];
  },
  'blank-number'(c) {
    const v = [...c.removed.map((id) => `removed: ${id}`), ...c.added.map((id) => `added: ${id}`)];
    for (const x of c.changed) {
      if (!x.tags.includes('blank-number')) { v.push(`non-blank-number invocation changed (${x.moved.join(',')}): ${x.id}`); continue; }
      if (x.moved.includes('argv')) v.push(`argv changed: ${x.id}`);
      if (x.after.exit !== 2) v.push(`blank number did not become exit 2 (got ${x.after.exit}): ${x.id}`);
      if (x.after.requests.length !== 0) v.push(`blank number still sent a request: ${x.id}`);
      if (x.after.stdout !== '') v.push(`blank number still printed stdout: ${x.id}`);
    }
    return v;
  },
  presentation(c) {
    const v = [...c.removed.map((id) => `removed: ${id}`), ...c.added.map((id) => `added: ${id}`)];
    for (const x of c.changed) {
      if (x.moved.includes('exit')) v.push(`EXIT CODE changed ${x.before.exit}→${x.after.exit}: ${x.id}`);
      if (x.moved.includes('requests')) v.push(`REQUESTS changed: ${x.id}`);
      if (x.moved.includes('argv')) v.push(`argv changed: ${x.id}`);
      if (x.tags.includes('json') && x.moved.includes('stdout')) v.push(`--json STDOUT changed: ${x.id}`);
    }
    return v;
  },
};

/** Per-category counts: `<tags> :: <moved fields>` → n. */
export function summarize(c) {
  const counts = {};
  for (const x of c.changed) {
    const key = `${x.tags.length ? x.tags.join('+') : 'plain'} :: ${x.moved.join('+')}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ei = args.indexOf('--expect');
  const profile = ei === -1 ? undefined : args[ei + 1];
  const files = args.filter((_, i) => i !== ei && i !== ei + 1);
  if (files.length < 1 || (profile && !PROFILES[profile])) {
    process.stderr.write(`Usage: diff-command-snapshot.mjs <old.json> [new.json] [--expect ${Object.keys(PROFILES).join('|')}]\n`);
    process.exit(2);
  }
  const load = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));
  const c = classify(load(files[0]), load(files[1] ?? resolve(ROOT, 'test/fixtures/command-behaviour.json')));
  process.stdout.write(`invocations: ${c.total.old} → ${c.total.new} (added ${c.added.length}, removed ${c.removed.length}, changed ${c.changed.length})\n`);
  for (const [k, n] of Object.entries(summarize(c)).sort((x, y) => y[1] - x[1])) process.stdout.write(`  ${String(n).padStart(5)}  ${k}\n`);
  if (profile) {
    const violations = PROFILES[profile](c);
    if (violations.length) {
      process.stdout.write(`\nprofile "${profile}": ${violations.length} violation(s)\n`);
      for (const line of violations.slice(0, 50)) process.stdout.write(`  ${line}\n`);
      if (violations.length > 50) process.stdout.write(`  … ${violations.length - 50} more\n`);
      process.exit(1);
    }
    process.stdout.write(`\nprofile "${profile}": OK\n`);
  }
}
