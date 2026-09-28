#!/usr/bin/env node
import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2));
// Exit only once stdout has drained: a bare process.exit() cuts a piped
// stdout off at the pipe buffer (~64 KB — e.g. `packs search --json | jq`).
process.stdout.write('', () => process.exit(code));
