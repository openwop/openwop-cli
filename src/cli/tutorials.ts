import type { Ctx } from '../context.js';
/**
 * `openwop tutorials ...` — the tutorials library + the caller's own progress
 * (feature: tutorials, ADR 0488 P1/D4; ADR 0490 always-on reader).
 *
 * Hits `/v1/host/openwop-app/tutorials*` (host-extension, non-normative). Reads
 * are never toggle-gated and degrade to the shipped seed (`degraded: true`).
 * Progress is per-caller and server-stamped; an anonymous caller reads
 * `persisted: false` and cannot save (403 → exit 4).
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { csv, enc, renderDone, renderList } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/tutorials';

export const TUTORIALS_HELP = `Usage:
  openwop tutorials list [--json]
  openwop tutorials get <slug> [--json]
  openwop tutorials progress [--json]
  openwop tutorials progress set <tutorialId> --steps <id,id,...> [--json]
  openwop tutorials progress clear <tutorialId> [--json]

The tutorial library (GET ${BASE}) and one tutorial in full (GET ${BASE}/<slug>).
\`progress\` reads YOUR saved steps (GET ${BASE}/progress); \`progress set\` replaces a
tutorial's completed steps and \`progress clear\` resets them (POST ${BASE}/progress,
body { tutorialId, completedStepIds, mode? }). The server stamps the user — you can
only write your own progress; anonymous sessions cannot save.

Exit codes: 0 ok · 2 usage / not found · 4 not signed in (progress set) or forbidden.

Examples:
  openwop tutorials list
  openwop tutorials get getting-started --json
  openwop tutorials progress set getting-started --steps intro,first-run
`;

export async function runTutorials(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, TUTORIALS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--steps'] });
  if (options.help) { write(ctx.io.stdout, TUTORIALS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      const items = Array.isArray(res.body?.tutorials) ? res.body.tutorials : [];
      const code = renderList(ctx, res.body, items, ['id', 'category', 'title', 'source'], 'No tutorials.');
      if (!ctx.json && res.body?.degraded) writeLine(ctx.io.stdout, '(shipped copy — the tenant library was unreachable)');
      return code;
    }
    case 'get': {
      const slug = positionals[0];
      if (!slug) { write(ctx.io.stderr, 'Usage: openwop tutorials get <slug>\n'); return 2; }
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${enc(slug)}`)).body);
      return 0;
    }
    case 'progress': {
      const action = positionals[0];
      if (!action) {
        const res = await requestJson(ctx, `${BASE}/progress`);
        const items = Array.isArray(res.body?.progress) ? res.body.progress : [];
        const code = renderList(ctx, res.body, items, ['tutorialId', 'steps', 'updatedAt'], 'No saved tutorial progress.',
          (p) => ({ tutorialId: p.tutorialId ?? '', steps: Array.isArray(p.completedStepIds) ? p.completedStepIds.length : 0, updatedAt: p.updatedAt ?? '' }));
        if (!ctx.json && res.body?.persisted === false) writeLine(ctx.io.stdout, '(not persisted — sign in to save progress on the server)');
        return code;
      }
      const tutorialId = positionals[1];
      if ((action !== 'set' && action !== 'clear') || !tutorialId) {
        write(ctx.io.stderr, 'Usage: openwop tutorials progress set <tutorialId> --steps <id,...> | progress clear <tutorialId>\n');
        return 2;
      }
      if (action === 'set' && options.steps === undefined) { write(ctx.io.stderr, 'tutorials progress set needs --steps.\n'); return 2; }
      const body = action === 'set'
        ? { tutorialId, completedStepIds: csv(options.steps) ?? [] }
        : { tutorialId, completedStepIds: [], mode: 'clear' };
      const res = await requestJson(ctx, `${BASE}/progress`, { method: 'POST', body });
      return renderDone(ctx, res.body, action === 'set'
        ? `Saved ${Array.isArray(res.body?.completedStepIds) ? res.body.completedStepIds.length : (body.completedStepIds as string[]).length} completed step(s) for ${tutorialId}.`
        : `Cleared progress for ${tutorialId}.`);
    }
    default: throw new CliError(`Unknown tutorials command: ${sub}\nRun \`openwop tutorials --help\` for usage.`);
  }
}
