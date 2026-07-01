import type { Ctx } from '../context.js';
/** `openwop podcasts ...` — podcast episodes + profiles (feature: podcasts). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const EP = '/v1/host/sample/podcasts/episodes';

export const PODCASTS_HELP = `Usage:
  openwop podcasts list [--json]
  openwop podcasts get <episodeId> [--json]
  openwop podcasts create --org <orgId> --notebook <notebookId> --episode-profile <profileId> [--title <t>] [--json]
  openwop podcasts delete <episodeId> [--yes]
  openwop podcasts retry <episodeId> [--json]

Podcast episodes (host-extension). \`create\` starts an episode; \`retry\` re-runs a
failed generation. The host is the authority; the CLI mirrors + relays.`;

export async function runPodcasts(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'delete', 'retry'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--title', '--org', '--notebook', '--episode-profile'] });
  if (options.help) { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, EP);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.episodes) ? res.body.episodes : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((e: any) => ({ id: e.id ?? '', title: e.title ?? '', status: e.status ?? '' })), ['id', 'title', 'status']) : 'No episodes.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop podcasts get <episodeId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${EP}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.notebook || !options.episodeProfile) { write(ctx.io.stderr, 'podcasts create needs --org, --notebook, and --episode-profile.\n'); return 2; }
      const body: Record<string, string> = { orgId: String(options.org), notebookId: String(options.notebook), episodeProfileId: String(options.episodeProfile) };
      if (options.title) body.title = String(options.title);
      const res = await requestJson(ctx, EP, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created episode ${res.body?.id ?? ''}.`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop podcasts delete <episodeId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete episode ${id} without --yes.`, 2);
      await requestJson(ctx, `${EP}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted episode ${id}.`); return 0;
    }
    case 'retry': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop podcasts retry <episodeId>\n'); return 2; }
      const res = await requestJson(ctx, `${EP}/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Retrying episode ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown podcasts command: ${sub}`);
  }
}
