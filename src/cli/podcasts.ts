import type { Ctx } from '../context.js';
/**
 * `openwop podcasts ...` — multi-speaker podcasts (feature: podcasts, ADR 0086)
 * + show (channel) distribution (ADR 0390).
 *
 * Host-extension surface under /v1/host/openwop-app/podcasts: speaker profiles
 * (a 1–4 voice cast), episode profiles (models + segment count), episodes (an
 * async generation run from a notebook), and shows (the publishable channel).
 * Org-scoped RBAC (workspace:read / workspace:write); no access is a uniform 404.
 * The host is the authority; the CLI mirrors + relays.
 */
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, mergeBody, parseJsonFlag, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const ROOT = '/v1/host/openwop-app/podcasts';
const EP = `${ROOT}/episodes`;

export const PODCASTS_HELP = `Usage:
  openwop podcasts episodes list --org <orgId> [--json]         (alias: podcasts list)
  openwop podcasts episodes get <episodeId> [--json]            (alias: podcasts get)
  openwop podcasts episodes create --org <orgId> --notebook <id> --episode-profile <id> [--title <t>] [--briefing <b>] [--json]
                                                                 (alias: podcasts create)
  openwop podcasts episodes retry <episodeId> [--json]          (alias: podcasts retry)
  openwop podcasts episodes publish <episodeId> [--show <showId>] [--description <d> | --clear-description]
                                    [--explicit | --not-explicit | --clear-explicit] [--json]
  openwop podcasts episodes unpublish <episodeId> [--json]
  openwop podcasts episodes delete <episodeId> [--yes] [--json] (alias: podcasts delete)
  openwop podcasts shows list --org <orgId> [--json]
  openwop podcasts shows get <showId> [--json]
  openwop podcasts shows create --org <orgId> --title <t> --author <a> [show flags] [--body <json>|--body-file <path>] [--json]
  openwop podcasts shows update <showId> [show flags] [--body <json>|--body-file <path>] [--json]
  openwop podcasts shows publish|unpublish <showId> [--json]
  openwop podcasts shows delete <showId> [--yes] [--json]
  openwop podcasts episode-profiles list --org <orgId> [--json]
  openwop podcasts episode-profiles create --org <orgId> --name <n> --speaker-profile <id> [--segment-count <n>]
                                           [--outline-model <m>] [--transcript-model <m>] [--language <code>]
                                           [--default-briefing <b>] [--body <json>|--body-file <path>] [--json]
  openwop podcasts episode-profiles delete <profileId> [--yes] [--json]
  openwop podcasts speaker-profiles list --org <orgId> [--json]
  openwop podcasts speaker-profiles create --org <orgId> --name <n> --speakers <json> [--provider <p>] [--model <m>]
                                           [--body <json>|--body-file <path>] [--json]
  openwop podcasts speaker-profiles delete <profileId> [--yes] [--json]

Podcasts (host-extension, ADR 0086 + ADR 0390) under /v1/host/openwop-app/podcasts.

  episodes          GET|POST /podcasts/episodes (?orgId=), GET|DELETE /episodes/<id>,
                    POST /episodes/<id>/retry|publish|unpublish. Generation is async:
                    create/retry enqueue a run and return the queued episode. Publish
                    binds the episode onto a show (--show, or its current show).
  shows             GET|POST /podcasts/shows (?orgId=), GET|PUT|DELETE /shows/<id>,
                    POST /shows/<id>/publish|unpublish. PUT merges: fields you omit keep
                    their stored value. Show flags: --title --author --description
                    --type episodic|serial --language --category --subcategory
                    --image-media-ref --owner-name --owner-email --slug --apple-url
                    --spotify-url --amazon-url --explicit|--not-explicit
  episode-profiles  GET|POST /podcasts/episode-profiles, DELETE /episode-profiles/<id>
  speaker-profiles  GET|POST /podcasts/speaker-profiles, DELETE /speaker-profiles/<id>;
                    --speakers is a JSON array of 1–4 {name, voiceId, backstory?, personality?}

Exit codes: 0 ok; 2 usage error or a 4xx (404 not found / no access, 400 validation);
4 permission denied (401/403); 1 server error.

Examples:
  openwop podcasts speaker-profiles create --org org_1 --name Duo \\
    --speakers '[{"name":"Ana","voiceId":"v1"},{"name":"Ben","voiceId":"v2"}]'
  openwop podcasts episode-profiles create --org org_1 --name Weekly --speaker-profile sp_1 --segment-count 4
  openwop podcasts episodes create --org org_1 --notebook nb_1 --episode-profile ep_1 --title "Ep 1"
  openwop podcasts shows create --org org_1 --title "The Show" --author "Acme" --type episodic
  openwop podcasts episodes publish e_1 --show show_1
`;

const SPEC = {
  bool: ['--help', '--yes', '--explicit', '--not-explicit', '--clear-explicit', '--clear-description'],
  value: [
    '--org', '--notebook', '--episode-profile', '--title', '--briefing', '--show', '--description', '--body', '--body-file',
    '--author', '--type', '--language', '--category', '--subcategory', '--image-media-ref', '--owner-name', '--owner-email',
    '--slug', '--apple-url', '--spotify-url', '--amazon-url',
    '--name', '--speaker-profile', '--segment-count', '--outline-model', '--transcript-model', '--default-briefing',
    '--speakers', '--provider', '--model',
  ],
};

function usage(ctx: Ctx, line: string): number {
  write(ctx.io.stderr, `Usage: openwop podcasts ${line}\n`);
  return 2;
}

function needOrg(ctx: Ctx, options: Record<string, any>, what: string): string | null {
  if (!options.org) { write(ctx.io.stderr, `podcasts ${what} needs --org <orgId>.\n`); return null; }
  return String(options.org);
}

export async function runPodcasts(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  switch (sub) {
    case 'episodes': return runEpisodes(ctx, argv[1] ?? 'list', argv.slice(2));
    case 'shows': return runShows(ctx, argv[1] ?? 'list', argv.slice(2));
    case 'episode-profiles': return runProfiles(ctx, 'episode-profiles', argv[1] ?? 'list', argv.slice(2));
    case 'speaker-profiles': return runProfiles(ctx, 'speaker-profiles', argv[1] ?? 'list', argv.slice(2));
    // Legacy verbs — episodes (kept stable).
    case 'list': case 'get': case 'create': case 'delete': case 'retry': case 'publish': case 'unpublish':
      return runEpisodes(ctx, sub, argv.slice(1));
    default: throw new CliError(`Unknown podcasts command: ${sub}\nRun \`openwop podcasts --help\` for usage.`);
  }
}

async function runEpisodes(ctx: Ctx, sub: string, argv: string[]) {
  const { options, positionals } = parseOptions(argv, SPEC);
  if (options.help || sub === '--help') { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const org = needOrg(ctx, options, 'episodes list'); if (!org) return 2;
      const res = await requestJson(ctx, withQuery(EP, { orgId: org }));
      return renderList(ctx, res.body, pickArray(res.body, 'episodes'), ['id', 'title', 'status', 'published'], 'No episodes.');
    }
    case 'get': {
      if (!id) return usage(ctx, 'episodes get <episodeId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${EP}/${enc(id)}`)).body); return 0;
    }
    case 'create': {
      if (!options.org || !options.notebook || !options.episodeProfile) { write(ctx.io.stderr, 'podcasts create needs --org, --notebook, and --episode-profile.\n'); return 2; }
      const body: Record<string, string> = { orgId: String(options.org), notebookId: String(options.notebook), episodeProfileId: String(options.episodeProfile) };
      if (options.title) body.title = String(options.title);
      if (options.briefing) body.briefing = String(options.briefing);
      const res = await requestJson(ctx, EP, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created episode ${res.body?.episode?.id ?? res.body?.id ?? ''} (queued).`);
    }
    case 'retry': {
      if (!id) return usage(ctx, 'episodes retry <episodeId>');
      const res = await requestJson(ctx, `${EP}/${enc(id)}/retry`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Retrying episode ${id}.`);
    }
    case 'publish': {
      if (!id) return usage(ctx, 'episodes publish <episodeId> [--show showId]');
      const body: Record<string, unknown> = {};
      if (options.show) body.showId = String(options.show);
      if (options.clearDescription) body.descriptionOverride = null;
      else if (options.description !== undefined) body.descriptionOverride = String(options.description);
      if (options.clearExplicit) body.explicitOverride = null;
      else if (options.explicit) body.explicitOverride = true;
      else if (options.notExplicit) body.explicitOverride = false;
      const res = await requestJson(ctx, `${EP}/${enc(id)}/publish`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Published episode ${id}${res.body?.episode?.showId ? ` on show ${res.body.episode.showId}` : ''}.`);
    }
    case 'unpublish': {
      if (!id) return usage(ctx, 'episodes unpublish <episodeId>');
      const res = await requestJson(ctx, `${EP}/${enc(id)}/unpublish`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Unpublished episode ${id}.`);
    }
    case 'delete': {
      if (!id) return usage(ctx, 'episodes delete <episodeId> [--yes]');
      if (!options.yes) throw new CliError(`Refusing to delete episode ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `${EP}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted episode ${id}.`);
    }
    default: throw new CliError(`Unknown podcasts episodes command: ${sub}`);
  }
}

function showFields(options: Record<string, any>): Record<string, unknown> {
  const map: Array<[string, string]> = [
    ['title', 'title'], ['author', 'author'], ['description', 'description'], ['type', 'type'], ['language', 'languageCode'],
    ['category', 'category'], ['subcategory', 'subcategory'], ['imageMediaRef', 'imageMediaRef'], ['ownerName', 'ownerName'],
    ['ownerEmail', 'ownerEmail'], ['slug', 'slug'], ['appleUrl', 'appleUrl'], ['spotifyUrl', 'spotifyUrl'], ['amazonUrl', 'amazonUrl'],
  ];
  const out: Record<string, unknown> = {};
  for (const [opt, field] of map) if (options[opt] !== undefined) out[field] = String(options[opt]);
  if (options.explicit) out.explicit = true;
  else if (options.notExplicit) out.explicit = false;
  return out;
}

async function runShows(ctx: Ctx, sub: string, argv: string[]) {
  const { options, positionals } = parseOptions(argv, SPEC);
  if (options.help || sub === '--help') { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  const id = positionals[0];
  const shows = `${ROOT}/shows`;
  switch (sub) {
    case 'list': {
      const org = needOrg(ctx, options, 'shows list'); if (!org) return 2;
      const res = await requestJson(ctx, withQuery(shows, { orgId: org }));
      return renderList(ctx, res.body, pickArray(res.body, 'shows'), ['id', 'title', 'slug', 'published'], 'No shows.');
    }
    case 'get': {
      if (!id) return usage(ctx, 'shows get <showId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${shows}/${enc(id)}`)).body); return 0;
    }
    case 'create': {
      const body = mergeBody(ctx, options, { ...showFields(options), ...(options.org ? { orgId: String(options.org) } : {}) });
      if (!body.orgId || !body.title || !body.author) { write(ctx.io.stderr, 'podcasts shows create needs --org, --title, and --author.\n'); return 2; }
      const res = await requestJson(ctx, shows, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created show ${res.body?.show?.id ?? ''} (${String(body.title)}).`);
    }
    case 'update': {
      if (!id) return usage(ctx, 'shows update <showId> [show flags]');
      const body = mergeBody(ctx, options, showFields(options));
      if (Object.keys(body).length === 0) { write(ctx.io.stderr, 'podcasts shows update needs at least one field to change.\n'); return 2; }
      const res = await requestJson(ctx, `${shows}/${enc(id)}`, { method: 'PUT', body });
      return renderDone(ctx, res.body, `Updated show ${id}.`);
    }
    case 'publish': case 'unpublish': {
      if (!id) return usage(ctx, `shows ${sub} <showId>`);
      const res = await requestJson(ctx, `${shows}/${enc(id)}/${sub}`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `${sub === 'publish' ? 'Published' : 'Unpublished'} show ${id}.`);
    }
    case 'delete': {
      if (!id) return usage(ctx, 'shows delete <showId> [--yes]');
      if (!options.yes) throw new CliError(`Refusing to delete show ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `${shows}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted show ${id}.`);
    }
    default: throw new CliError(`Unknown podcasts shows command: ${sub}`);
  }
}

async function runProfiles(ctx: Ctx, kind: 'episode-profiles' | 'speaker-profiles', sub: string, argv: string[]) {
  const { options, positionals } = parseOptions(argv, SPEC);
  if (options.help || sub === '--help') { write(ctx.io.stdout, PODCASTS_HELP); return 0; }
  const url = `${ROOT}/${kind}`;
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const org = needOrg(ctx, options, `${kind} list`); if (!org) return 2;
      const res = await requestJson(ctx, withQuery(url, { orgId: org }));
      const cols = kind === 'speaker-profiles' ? ['id', 'name', 'provider', 'speakers'] : ['id', 'name', 'speakerProfileId', 'segmentCount'];
      return renderList(ctx, res.body, pickArray(res.body, 'profiles'), cols, 'No profiles.',
        (p) => Object.fromEntries(cols.map((c) => [c, c === 'speakers' ? (Array.isArray(p.speakers) ? p.speakers.map((s: any) => s?.name).join(', ') : '') : (p[c] ?? '')])));
    }
    case 'create': {
      const fields: Record<string, unknown> = {};
      if (options.org) fields.orgId = String(options.org);
      if (options.name) fields.name = String(options.name);
      if (kind === 'speaker-profiles') {
        if (options.speakers !== undefined) fields.speakers = parseJsonFlag('--speakers', options.speakers);
        if (options.provider) fields.provider = String(options.provider);
        if (options.model) fields.model = String(options.model);
      } else {
        if (options.speakerProfile) fields.speakerProfileId = String(options.speakerProfile);
        if (options.segmentCount !== undefined) fields.segmentCount = Number(options.segmentCount);
        if (options.outlineModel) fields.outlineModel = String(options.outlineModel);
        if (options.transcriptModel) fields.transcriptModel = String(options.transcriptModel);
        if (options.language) fields.languageCode = String(options.language);
        if (options.defaultBriefing) fields.defaultBriefing = String(options.defaultBriefing);
      }
      const body = mergeBody(ctx, options, fields);
      const required = kind === 'speaker-profiles' ? ['orgId', 'name', 'speakers'] : ['orgId', 'name', 'speakerProfileId'];
      const missing = required.filter((k) => body[k] === undefined);
      if (missing.length) { write(ctx.io.stderr, `podcasts ${kind} create is missing: ${missing.join(', ')}.\n`); return 2; }
      const res = await requestJson(ctx, url, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created ${kind === 'speaker-profiles' ? 'speaker' : 'episode'} profile ${res.body?.profile?.id ?? ''}.`);
    }
    case 'delete': {
      if (!id) return usage(ctx, `${kind} delete <profileId> [--yes]`);
      if (!options.yes) throw new CliError(`Refusing to delete profile ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `${url}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted profile ${id}.`);
    }
    default: throw new CliError(`Unknown podcasts ${kind} command: ${sub}`);
  }
}
