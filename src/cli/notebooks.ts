import type { Ctx } from '../context.js';
/**
 * `openwop notebooks ...` — Research Notebooks (feature: notebooks, ADR 0084).
 *
 * Host-extension surface under /v1/host/openwop-app/notebooks: a notebook is a
 * project Subject with a bound KB collection — sources (text, file, audio/video
 * transcription, YouTube), notes, transformations, a grounded chat and semantic
 * search. RBAC is the project model (workspace:read / workspace:write); a
 * no-access id is a uniform 404. The host is the authority; the CLI relays.
 */
import { readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, pickArray, renderDone, renderList } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/notebooks';

export const NOTEBOOKS_HELP = `Usage:
  openwop notebooks list [--json]
  openwop notebooks get <notebookId> [--json]
  openwop notebooks create --org <orgId> --name <n> [--json]
  openwop notebooks ensure <projectId> [--json]
  openwop notebooks delete <notebookId> [--yes] [--json]
  openwop notebooks notes [list] <notebookId> [--json]
  openwop notebooks notes add <notebookId> --text <t> [--authored] [--json]
  openwop notebooks sources list <notebookId> [--json]
  openwop notebooks sources add <notebookId> (--text <t> | --file <path> [--content-type <mime>]) [--title <t>] [--json]
  openwop notebooks sources audio <notebookId> --file <path> [--content-type <mime>] [--title <t>] [--language <code>] [--json]
  openwop notebooks sources youtube <notebookId> --url <url> [--title <t>] [--json]
  openwop notebooks sources summarize <notebookId> <sourceId> [--json]
  openwop notebooks sources transform <notebookId> <sourceId> --template <templateId> [--json]
  openwop notebooks sources context-level <notebookId> <sourceId> --level full|summary|excluded [--json]
  openwop notebooks transformations [list] <notebookId> [--json]
  openwop notebooks transformations templates <notebookId> [--json]
  openwop notebooks chat <notebookId> [--json]
  openwop notebooks search <notebookId> <query...> [--top-k <n>] [--json]

Research notebooks (host-extension, ADR 0084) under
/v1/host/openwop-app/notebooks. A notebook holds sources + notes + a grounded chat.

  create       POST /notebooks {orgId, name}
  ensure       POST /notebooks/<id>/ensure — provision sources for an EXISTING project (idempotent)
  delete       DELETE /notebooks/<id> — cascades the KB collection, board, memory, binding
  notes        GET|POST /notebooks/<id>/notes {text, origin}; --authored marks a
               human-composed note as trusted (origin "authored"), otherwise it is
               fenced as third-party content
  sources      GET|POST /notebooks/<id>/sources {title?, text | contentBase64+contentType};
               audio → POST /sources/audio (base64 bytes; enqueues a transcription run);
               youtube → POST /sources/youtube {url}; summarize/transform enqueue runs;
               context-level → PUT /sources/<sid>/context-level {level}
  transformations  GET /notebooks/<id>/transformations (+ /templates catalog)
  chat         POST /notebooks/<id>/chat — opens/reuses the notebook's grounded
               conversation and prints its conversationId (drive it with \`openwop chat\`)
  search       POST /notebooks/<id>/search {query, topK?}

Local files are read and sent as base64 JSON; the MIME type is inferred from the
extension unless --content-type is given.

Exit codes: 0 ok; 2 usage error or a 4xx (e.g. 404 not found / no access);
4 permission denied (401/403); 1 server error.

Examples:
  openwop notebooks create --org org_1 --name "Market research"
  openwop notebooks sources add nb_1 --file ./brief.pdf --title Brief
  openwop notebooks sources audio nb_1 --file ./interview.mp3 --language en
  openwop notebooks sources context-level nb_1 src_1 --level excluded
  openwop notebooks search nb_1 "pricing objections" --top-k 5 --json
`;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.csv': 'text/csv', '.json': 'application/json', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

/** Read a local file as base64 + resolve its MIME (flag wins over the extension). */
export function readFileBase64(ctx: Ctx, file: string, contentType?: unknown): { contentBase64: string; contentType: string } {
  let buf: Buffer;
  try {
    buf = readFileSync(resolvePath(ctx.cwd, file));
  } catch (err) {
    throw new CliError(`Cannot read file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mime = contentType ? String(contentType) : MIME[extname(file).toLowerCase()];
  if (!mime) throw new CliError(`Cannot infer a content type for ${file} — pass --content-type <mime>.`);
  return { contentBase64: buf.toString('base64'), contentType: mime };
}

const SPEC = {
  bool: ['--help', '--yes', '--authored'],
  value: ['--org', '--name', '--text', '--title', '--file', '--content-type', '--language', '--url', '--template', '--level', '--top-k'],
};

function usage(ctx: Ctx, line: string): number {
  write(ctx.io.stderr, `Usage: openwop notebooks ${line}\n`);
  return 2;
}

export async function runNotebooks(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  if (sub === 'sources') return runSources(ctx, argv.slice(1));
  if (sub === 'notes') return runNotes(ctx, argv.slice(1));
  if (sub === 'transformations') return runTransformations(ctx, argv.slice(1));
  const known = ['list', 'get', 'create', 'delete', 'ensure', 'chat', 'search'];
  const args = argv.slice(known.includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, SPEC);
  if (options.help) { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      return renderList(ctx, res.body, pickArray(res.body, 'notebooks'), ['id', 'name', 'orgId'], 'No notebooks.',
        (n) => ({ id: n.id ?? '', name: n.name ?? n.title ?? '', orgId: n.orgId ?? '' }));
    }
    case 'get': {
      if (!id) return usage(ctx, 'get <notebookId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${enc(id)}`)).body); return 0;
    }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'notebooks create needs --org and --name.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { orgId: String(options.org), name: String(options.name) } });
      return renderDone(ctx, res.body, `Created notebook ${res.body?.notebook?.id ?? res.body?.id ?? ''} (${String(options.name)}).`);
    }
    case 'ensure': {
      if (!id) return usage(ctx, 'ensure <projectId>');
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/ensure`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Notebook ready for project ${id} (collection ${res.body?.collectionId ?? ''}).`);
    }
    case 'delete': {
      if (!id) return usage(ctx, 'delete <notebookId> [--yes]');
      if (!options.yes) throw new CliError(`Refusing to delete notebook ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `${BASE}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted notebook ${id}.`);
    }
    case 'chat': {
      if (!id) return usage(ctx, 'chat <notebookId>');
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/chat`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Notebook conversation: ${res.body?.conversationId ?? ''}`);
    }
    case 'search': {
      const query = positionals.slice(1).join(' ');
      if (!id || !query) return usage(ctx, 'search <notebookId> <query...> [--top-k n]');
      const body: Record<string, unknown> = { query };
      if (options.topK !== undefined) {
        const n = Number(options.topK);
        if (!Number.isFinite(n) || n <= 0) throw new CliError('--top-k must be a positive number');
        body.topK = n;
      }
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/search`, { method: 'POST', body });
      return renderList(ctx, res.body, pickArray(res.body, 'results', 'hits', 'chunks'), ['score', 'title', 'text'], 'No matches.',
        (h) => ({ score: typeof h.score === 'number' ? h.score.toFixed(3) : (h.score ?? ''), title: h.title ?? h.documentTitle ?? h.documentId ?? '', text: String(h.text ?? h.content ?? '').replace(/\s+/g, ' ').slice(0, 80) }));
    }
    default: throw new CliError(`Unknown notebooks command: ${sub}\nRun \`openwop notebooks --help\` for usage.`);
  }
}

async function runNotes(ctx: Ctx, argv: string[]) {
  const sub = argv[0] === 'add' || argv[0] === 'list' ? argv[0] : 'list';
  const { options, positionals } = parseOptions(argv.slice(argv[0] === sub ? 1 : 0), SPEC);
  if (options.help) { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const id = positionals[0];
  if (sub === 'list') {
    if (!id) return usage(ctx, 'notes [list] <notebookId>');
    const res = await requestJson(ctx, `${BASE}/${enc(id)}/notes`);
    return renderList(ctx, res.body, pickArray(res.body, 'notes'), ['id', 'origin', 'text'], 'No notes.',
      (n) => ({ id: n.id ?? '', origin: n.origin ?? '', text: String(n.text ?? '').replace(/\s+/g, ' ').slice(0, 80) }));
  }
  if (!id || !options.text) return usage(ctx, 'notes add <notebookId> --text <t> [--authored]');
  const res = await requestJson(ctx, `${BASE}/${enc(id)}/notes`, {
    method: 'POST', body: { text: String(options.text), origin: options.authored ? 'authored' : 'third-party' },
  });
  return renderDone(ctx, res.body, `Added note to notebook ${id}.`);
}

async function runTransformations(ctx: Ctx, argv: string[]) {
  const sub = argv[0] === 'templates' || argv[0] === 'list' ? argv[0] : 'list';
  const { options, positionals } = parseOptions(argv.slice(argv[0] === sub ? 1 : 0), SPEC);
  if (options.help) { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const id = positionals[0];
  if (!id) return usage(ctx, `transformations ${sub} <notebookId>`);
  if (sub === 'templates') {
    const res = await requestJson(ctx, `${BASE}/${enc(id)}/transformations/templates`);
    return renderList(ctx, res.body, pickArray(res.body, 'templates'), ['id', 'label'], 'No transformation templates.');
  }
  const res = await requestJson(ctx, `${BASE}/${enc(id)}/transformations`);
  return renderList(ctx, res.body, pickArray(res.body, 'transformations'), ['documentId', 'title', 'kind', 'status'], 'No transformations.');
}

async function runSources(ctx: Ctx, argv: string[]) {
  const subs = ['list', 'add', 'audio', 'youtube', 'summarize', 'transform', 'context-level'];
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  if (!subs.includes(sub)) throw new CliError(`Unknown notebooks sources command: ${sub}\nRun \`openwop notebooks --help\` for usage.`);
  const { options, positionals } = parseOptions(argv.slice(1), SPEC);
  if (options.help) { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const [id, sid] = positionals;
  if (!id) return usage(ctx, `sources ${sub} <notebookId> …`);
  const src = `${BASE}/${enc(id)}/sources`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, src);
      return renderList(ctx, res.body, pickArray(res.body, 'sources'), ['id', 'title', 'contextLevel'], 'No sources.',
        (s) => ({ id: s.id ?? s.documentId ?? '', title: s.title ?? '', contextLevel: s.contextLevel ?? '' }));
    }
    case 'add': {
      const body: Record<string, unknown> = {};
      if (options.title) body.title = String(options.title);
      if (options.file) Object.assign(body, readFileBase64(ctx, String(options.file), options.contentType));
      else if (options.text) body.text = String(options.text);
      else return usage(ctx, 'sources add <notebookId> (--text <t> | --file <path>) [--title t]');
      const res = await requestJson(ctx, src, { method: 'POST', body });
      return renderDone(ctx, res.body, `Added source ${res.body?.id ?? res.body?.documentId ?? ''} to notebook ${id}.`);
    }
    case 'audio': {
      if (!options.file) return usage(ctx, 'sources audio <notebookId> --file <path> [--content-type mime] [--title t] [--language code]');
      const body: Record<string, unknown> = { ...readFileBase64(ctx, String(options.file), options.contentType) };
      if (options.title) body.title = String(options.title);
      if (options.language) body.language = String(options.language);
      const res = await requestJson(ctx, `${src}/audio`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Transcription queued (run ${res.body?.runId ?? ''}).`);
    }
    case 'youtube': {
      if (!options.url) return usage(ctx, 'sources youtube <notebookId> --url <url> [--title t]');
      const body: Record<string, unknown> = { url: String(options.url) };
      if (options.title) body.title = String(options.title);
      const res = await requestJson(ctx, `${src}/youtube`, { method: 'POST', body });
      return renderDone(ctx, res.body, `YouTube ingest queued (run ${res.body?.runId ?? ''}).`);
    }
    case 'summarize': {
      if (!sid) return usage(ctx, 'sources summarize <notebookId> <sourceId>');
      const res = await requestJson(ctx, `${src}/${enc(sid)}/summarize`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Summarize queued (run ${res.body?.runId ?? ''}).`);
    }
    case 'transform': {
      if (!sid || !options.template) return usage(ctx, 'sources transform <notebookId> <sourceId> --template <templateId>');
      const res = await requestJson(ctx, `${src}/${enc(sid)}/transform`, { method: 'POST', body: { templateId: String(options.template) } });
      return renderDone(ctx, res.body, `Transformation queued (run ${res.body?.runId ?? ''}).`);
    }
    case 'context-level': {
      const level = options.level ? String(options.level) : '';
      if (!sid || !['full', 'summary', 'excluded'].includes(level)) return usage(ctx, 'sources context-level <notebookId> <sourceId> --level full|summary|excluded');
      const res = await requestJson(ctx, `${src}/${enc(sid)}/context-level`, { method: 'PUT', body: { level } });
      return renderDone(ctx, res.body, `Source ${sid} context level set to ${level}.`);
    }
    default: return 2;
  }
}
