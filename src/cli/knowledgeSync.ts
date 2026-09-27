import type { Ctx } from '../context.js';
/**
 * `openwop knowledge-sync ...` — knowledge-sync sources (feature: knowledge-sync,
 * ADR 0107; media opt-out ADR 0108; hardening ADR 0605).
 *
 * Host-extension surface under /v1/host/openwop-app/knowledge-sync: a source binds
 * one of the caller's own storage Connections (Google Drive, Microsoft, Dropbox,
 * Box) + a folder to a KB collection and keeps it in sync on a cadence. Org-scoped
 * RBAC (workspace:read / workspace:write); no access is a uniform 404. The host is
 * the authority for the diff pass; the CLI only relays.
 */
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/knowledge-sync';

export const KNOWLEDGE_SYNC_HELP = `Usage:
  openwop knowledge-sync list --org <orgId> [--json]
  openwop knowledge-sync get <sourceId> [--json]
  openwop knowledge-sync create --org <orgId> --connection <connectionId> --collection <collectionId>
                                --folder <folderIdOrUrl> [--cadence 15m|hourly|daily] [--provider <p>]
                                [--no-media] [--json]
  openwop knowledge-sync browse --org <orgId> --connection <connectionId> [--folder <folderId>] [--json]
  openwop knowledge-sync update <sourceId> (--include-media | --no-media) [--json]
  openwop knowledge-sync pause|resume <sourceId> [--json]
  openwop knowledge-sync sync <sourceId> [--json]
  openwop knowledge-sync delete <sourceId> [--yes] [--json]

Knowledge-sync sources (host-extension, ADR 0107) under
/v1/host/openwop-app/knowledge-sync.

  list/create  GET|POST /knowledge-sync (?orgId=). The connection must be YOUR OWN;
               a Google Drive folder link is normalized to its id by the server.
  browse       GET /knowledge-sync/browse?orgId=&connectionId=&folderId= — list the
               folders your connection can see (default folder: root)
  get/delete   GET|DELETE /knowledge-sync/<id>
  update       PATCH /knowledge-sync/<id> {includeMedia} — turning media off prunes
               already-synced image/audio/video on the next pass
  pause/resume POST /knowledge-sync/<id>/pause|resume
  sync         POST /knowledge-sync/<id>/sync — run one diff pass now and print its
               counts (a 409 means another pass holds the claim; try again shortly)

Exit codes: 0 ok; 2 usage error or a 4xx (404 not found / no access, 409 busy);
4 permission denied (401/403); 1 server error.

Examples:
  openwop knowledge-sync browse --org org_1 --connection conn_1 --folder root
  openwop knowledge-sync create --org org_1 --connection conn_1 --collection col_1 \\
    --folder https://drive.google.com/drive/folders/abc --cadence daily
  openwop knowledge-sync sync ks_1 --json
`;

const SPEC = {
  bool: ['--help', '--yes', '--include-media', '--no-media'],
  value: ['--org', '--connection', '--collection', '--folder', '--cadence', '--provider'],
};

function usage(ctx: Ctx, line: string): number {
  write(ctx.io.stderr, `Usage: openwop knowledge-sync ${line}\n`);
  return 2;
}

export async function runKnowledgeSync(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, KNOWLEDGE_SYNC_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), SPEC);
  if (options.help) { write(ctx.io.stdout, KNOWLEDGE_SYNC_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      if (!options.org) return usage(ctx, 'list --org <orgId>');
      const res = await requestJson(ctx, withQuery(BASE, { orgId: String(options.org) }));
      return renderList(ctx, res.body, pickArray(res.body, 'sources'), ['id', 'provider', 'collectionId', 'cadence', 'status', 'lastSyncedAt'], 'No sync sources.');
    }
    case 'get': {
      if (!id) return usage(ctx, 'get <sourceId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${enc(id)}`)).body); return 0;
    }
    case 'create': {
      if (!options.org || !options.connection || !options.collection || !options.folder) {
        return usage(ctx, 'create --org <orgId> --connection <id> --collection <id> --folder <folderIdOrUrl> [--cadence c]');
      }
      const body: Record<string, unknown> = {
        orgId: String(options.org), connectionId: String(options.connection),
        collectionId: String(options.collection), externalFolderId: String(options.folder),
      };
      if (options.cadence) body.cadence = String(options.cadence);
      if (options.provider) body.provider = String(options.provider);
      if (options.noMedia) body.includeMedia = false;
      const res = await requestJson(ctx, BASE, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created sync source ${res.body?.source?.id ?? ''}.`);
    }
    case 'browse': {
      if (!options.org || !options.connection) return usage(ctx, 'browse --org <orgId> --connection <connectionId> [--folder id]');
      const res = await requestJson(ctx, withQuery(`${BASE}/browse`, {
        orgId: String(options.org), connectionId: String(options.connection), folderId: options.folder,
      }));
      return renderList(ctx, res.body, pickArray(res.body, 'folders'), ['id', 'name'], 'No folders.');
    }
    case 'update': {
      if (!id || (!options.includeMedia && !options.noMedia)) return usage(ctx, 'update <sourceId> (--include-media | --no-media)');
      const res = await requestJson(ctx, `${BASE}/${enc(id)}`, { method: 'PATCH', body: { includeMedia: !options.noMedia } });
      return renderDone(ctx, res.body, `Updated sync source ${id} (media ${options.noMedia ? 'excluded' : 'included'}).`);
    }
    case 'pause': case 'resume': {
      if (!id) return usage(ctx, `${sub} <sourceId>`);
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/${sub}`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `${sub === 'pause' ? 'Paused' : 'Resumed'} sync source ${id}.`);
    }
    case 'sync': {
      if (!id) return usage(ctx, 'sync <sourceId>');
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/sync`, { method: 'POST', body: {} });
      const r = res.body?.result ?? {};
      const counts = Object.entries(r).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ');
      return renderDone(ctx, res.body, `Synced source ${id}${counts ? `: ${counts}` : '.'}`);
    }
    case 'delete': {
      if (!id) return usage(ctx, 'delete <sourceId> [--yes]');
      if (!options.yes) throw new CliError(`Refusing to delete sync source ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `${BASE}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted sync source ${id}.`);
    }
    default: throw new CliError(`Unknown knowledge-sync command: ${sub}\nRun \`openwop knowledge-sync --help\` for usage.`);
  }
}
