// Behaviour snapshot of every command-table command — the routeKit-native
// `RouteCmd[]` groups and the src/cli/resourceCommands.ts spec-table groups:
// what each command sends and prints, for a generated matrix of invocations,
// pinned against test/fixtures/command-behaviour.json.
//
// A red here means a command's wire request, output, or exit code changed.
// Do NOT regenerate the fixture to make it pass unless the change is intended;
// regenerate with `node scripts/snapshot-commands.mjs` and review the diff —
// classify it with `node scripts/diff-command-snapshot.mjs <old> --expect …`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { generateSnapshot, FIXTURE } from '../scripts/snapshot-commands.mjs';

describe('command behaviour snapshot', () => {
  it('every command-table command behaves exactly as pinned', async () => {
    const live = await generateSnapshot();
    const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    assert.ok(live.commandCount > 450, `enumerated only ${live.commandCount} commands`);
    assert.deepEqual(Object.keys(live.groups), Object.keys(pinned.groups));
    for (const [group, entry] of Object.entries(pinned.groups)) {
      const got = live.groups[group];
      assert.deepEqual(got.help, entry.help, `${group} --help`);
      assert.deepEqual(got.groupErrors, entry.groupErrors, `${group} group errors`);
      assert.deepEqual(Object.keys(got.commands), Object.keys(entry.commands), `${group} command set`);
      for (const [key, rows] of Object.entries(entry.commands)) {
        assert.equal(got.commands[key].length, rows.length, `${group} ${key}: variant count`);
        rows.forEach((row, i) => assert.deepEqual(got.commands[key][i], row, `${group} ${key} [${row.variant}]`));
      }
    }
    assert.deepEqual(live, pinned);
  });
});
