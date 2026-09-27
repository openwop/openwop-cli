import type { Ctx } from '../context.js';
/**
 * `openwop funnels ...` — multi-step funnels (ADR 0294, experiments ADR 0330).
 *
 * Operator surface: /v1/host/openwop-app/funnels/orgs/{orgId}/funnels[/...]
 * (toggle `funnels`; read = workspace:read, write = workspace:write in the org).
 * Visitor surface (`public ...`): /v1/host/openwop-app/public/{orgId}/funnels/{slug}
 * — anonymous; a published funnel only; unknown/unpublished/toggle-off = 404.
 */
import { requestJson } from '../api.js';
import { writeLine, writeJson } from '../io.js';
import { requireOrg } from './shared.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, qs, parseJsonFlag, table, type Cmd,
} from './marketingShared.js';

const base = (org: string) => `${APP}/funnels/orgs/${enc(org)}/funnels`;
const pub = (org: string, slug: string) => `${APP}/public/${enc(org)}/funnels/${enc(slug)}`;

export const FUNNELS_HELP = `Usage:
  openwop funnels list --org <orgId> [--json]
  openwop funnels get <funnelId> --org <orgId> [--json]
  openwop funnels create --org <orgId> --name <n> [--slug <s>] [--steps-json '[...]'] [--body <json>|--body-file <f>] [--json]
  openwop funnels update <funnelId> --org <orgId> [--name <n>] [--slug <s>] [--steps-json '[...]'] [--completion-cta-json '{...}'] [--body <json>] [--json]
  openwop funnels publish|unpublish|archive <funnelId> --org <orgId> [--json]
  openwop funnels delete <funnelId> --org <orgId> --yes
  openwop funnels stats <funnelId> --org <orgId> [--json]
  openwop funnels stats-rebuild <funnelId> --org <orgId> [--json]
  openwop funnels experiment-set <funnelId> <stepId> --org <orgId> --variants-json '[...]' [--json]
  openwop funnels experiment-stop <funnelId> <stepId> --org <orgId> --yes [--json]
  openwop funnels experiment-results <funnelId> <stepId> --org <orgId> [--json]
  openwop funnels public view <orgId> <slug> [--vk <visitorKey>] [--utm key=value]... [--json]
  openwop funnels public step <orgId> <slug> <stepIx> [--vk <k>] [--utm key=value]... [--json]
  openwop funnels public next <orgId> <slug> --from <stepId> [--outcome accepted|declined] [--submission <id>] [--vk <k>] [--json]

Funnels (ADR 0294): an ordered set of steps (pages, forms, offers) published at a
slug. Operator commands hit /v1/host/openwop-app/funnels/orgs/{orgId}/funnels and
need --org. 'stats' is the per-step views/completions/revenue roll-up;
'stats-rebuild' re-derives it from the event window. 'experiment-*' manage an
A/B split on one step (ADR 0330). 'update' is a partial PATCH — only the fields
you pass change.

'public' drives the anonymous visitor surface
/v1/host/openwop-app/public/{orgId}/funnels/{slug}[/steps/{ix}|/next] exactly as the
frontend does (no auth). Pass --vk only with a consented visitor key: views and
completions are recorded as funnel events for that visitor.

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown/unpublished funnel);
4 auth/permission denied; 1 server error.

Examples:
  openwop funnels list --org org_1
  openwop funnels create --org org_1 --name "Webinar funnel" --slug webinar --steps-json '[{"kind":"page"}]'
  openwop funnels publish fn_1 --org org_1
  openwop funnels public view org_1 webinar --json
`;

function orgOf(a: { options: Record<string, any> }): string { return requireOrg(a.options.org); }

function funnelBody(a: { options: Record<string, any>; body: Record<string, any> }): Record<string, any> {
  const o = a.options;
  return assign({ ...a.body }, {
    name: o.name,
    slug: o.slug,
    steps: o.stepsJson !== undefined ? parseJsonFlag(o.stepsJson, '--steps-json') : undefined,
    completionCta: o.completionCtaJson !== undefined ? parseJsonFlag(o.completionCtaJson, '--completion-cta-json') : undefined,
  });
}

function renderFunnel(ctx: Ctx, body: any, verb: string): number {
  const f = body?.funnel ?? {};
  return done(ctx, body, `${verb} funnel ${f.funnelId ?? ''}${f.status ? ` (${f.status})` : ''}.`);
}

const lifecycle = (action: 'publish' | 'unpublish' | 'archive', verb: string): Cmd => ({
  usage: `${action} <funnelId> --org <orgId> [--json]`, args: 1, value: ['--org'],
  run: async (ctx, a) => renderFunnel(ctx, (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/${action}`, { method: 'POST' })).body, verb),
});

const TABLE: Record<string, Cmd> = {
  list: {
    usage: 'list --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, base(orgOf(a)))).body, 'funnels',
      ['funnelId', 'name', 'slug', 'status', ['steps', (f) => f.steps]], 'No funnels.'),
  },
  get: {
    usage: 'get <funnelId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}`)).body, 'funnel'),
  },
  create: {
    usage: "create --org <orgId> --name <n> [--slug <s>] [--steps-json '[...]'] [--body <json>|--body-file <f>] [--json]",
    args: 0, body: true, value: ['--org', '--name', '--slug', '--steps-json'], requires: ['name'],
    run: async (ctx, a) => renderFunnel(ctx, (await requestJson(ctx, base(orgOf(a)), { method: 'POST', body: funnelBody(a) })).body, 'Created'),
  },
  update: {
    usage: "update <funnelId> --org <orgId> [--name <n>] [--slug <s>] [--steps-json '[...]'] [--completion-cta-json '{...}'] [--body <json>] [--json]",
    args: 1, body: true, value: ['--org', '--name', '--slug', '--steps-json', '--completion-cta-json'],
    run: async (ctx, a) => renderFunnel(ctx, (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}`, { method: 'PATCH', body: funnelBody(a) })).body, 'Updated'),
  },
  publish: lifecycle('publish', 'Published'),
  unpublish: lifecycle('unpublish', 'Unpublished'),
  archive: lifecycle('archive', 'Archived'),
  delete: {
    usage: 'delete <funnelId> --org <orgId> --yes', args: 1, value: ['--org'], confirm: 'delete the funnel',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted funnel ${a.positionals[0]}.`),
  },
  stats: {
    usage: 'stats <funnelId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => {
      const body = (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/stats`)).body;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
      const steps = Array.isArray(body?.steps) ? body.steps : [];
      writeLine(ctx.io.stdout, steps.length
        ? table(steps, ['stepId', 'kind', 'views', 'completions', 'conversion', 'orders', 'revenue'])
        : 'No step statistics yet.');
      if (body?.rebuiltAt) writeLine(ctx.io.stdout, `rebuiltAt: ${body.rebuiltAt}`);
      return 0;
    },
  },
  'stats-rebuild': {
    usage: 'stats-rebuild <funnelId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => {
      const body = (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/stats/rebuild`, { method: 'POST' })).body;
      return done(ctx, body, `Rebuilt funnel statistics (${body?.rows ?? 0} rows).`);
    },
  },
  'experiment-set': {
    usage: "experiment-set <funnelId> <stepId> --org <orgId> --variants-json '[...]' [--json]",
    args: 2, value: ['--org', '--variants-json'], requires: ['variantsJson'],
    run: async (ctx, a) => {
      const [fid, sid] = a.positionals;
      const variants = parseJsonFlag(a.options.variantsJson, '--variants-json');
      const body = (await requestJson(ctx, `${base(orgOf(a))}/${enc(fid)}/steps/${enc(sid)}/experiment`, { method: 'POST', body: { variants } })).body;
      return done(ctx, body, `Started an experiment on step ${sid} of funnel ${fid}.`);
    },
  },
  'experiment-stop': {
    usage: 'experiment-stop <funnelId> <stepId> --org <orgId> --yes [--json]', args: 2, value: ['--org'], confirm: 'stop the experiment',
    run: async (ctx, a) => {
      const [fid, sid] = a.positionals;
      const body = (await requestJson(ctx, `${base(orgOf(a))}/${enc(fid)}/steps/${enc(sid)}/experiment`, { method: 'DELETE' })).body;
      return done(ctx, body, `Stopped the experiment on step ${sid} of funnel ${fid}.`);
    },
  },
  'experiment-results': {
    usage: 'experiment-results <funnelId> <stepId> --org <orgId> [--json]', args: 2, value: ['--org'],
    run: async (ctx, a) => {
      const [fid, sid] = a.positionals;
      return detail(ctx, (await requestJson(ctx, `${base(orgOf(a))}/${enc(fid)}/steps/${enc(sid)}/experiment/results`)).body);
    },
  },
};

function utmQuery(options: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of options.utm ?? []) {
    const eq = String(pair).indexOf('=');
    if (eq <= 0) continue;
    out[`utm_${String(pair).slice(0, eq).replace(/^utm_/, '')}`] = String(pair).slice(eq + 1);
  }
  return out;
}

function renderPublicStep(ctx: Ctx, body: any): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  const f = body?.funnel ?? {};
  writeLine(ctx.io.stdout, `funnel: ${f.name ?? ''} (${f.slug ?? ''}) — ${body?.stepCount ?? '?'} steps`);
  if (body?.complete) {
    writeLine(ctx.io.stdout, 'complete: yes');
    if (body.completionCta) writeLine(ctx.io.stdout, `completionCta: ${JSON.stringify(body.completionCta)}`);
    return 0;
  }
  const s = body?.step ?? {};
  writeLine(ctx.io.stdout, `step: ${s.ix ?? ''} ${s.stepId ?? ''} (${s.kind ?? ''})${s.experiment ? ` [variant ${s.experiment.variantId ?? JSON.stringify(s.experiment)}]` : ''}`);
  return 0;
}

const PUBLIC: Record<string, Cmd> = {
  view: {
    usage: 'view <orgId> <slug> [--vk <visitorKey>] [--utm key=value]... [--json]', args: 2, value: ['--vk'], multi: ['--utm'],
    run: async (ctx, a) => renderPublicStep(ctx, (await requestJson(ctx, `${pub(a.positionals[0], a.positionals[1])}${qs({ vk: a.options.vk, ...utmQuery(a.options) })}`, { auth: false })).body),
  },
  step: {
    usage: 'step <orgId> <slug> <stepIx> [--vk <k>] [--utm key=value]... [--json]', args: 3, value: ['--vk'], multi: ['--utm'],
    run: async (ctx, a) => {
      const [org, slug, ix] = a.positionals;
      return renderPublicStep(ctx, (await requestJson(ctx, `${pub(org, slug)}/steps/${enc(ix)}${qs({ vk: a.options.vk, ...utmQuery(a.options) })}`, { auth: false })).body);
    },
  },
  next: {
    usage: 'next <orgId> <slug> --from <stepId> [--outcome accepted|declined] [--submission <id>] [--vk <k>] [--utm key=value]... [--json]',
    args: 2, value: ['--from', '--outcome', '--submission', '--vk'], multi: ['--utm'], requires: ['from'],
    run: async (ctx, a) => {
      const [org, slug] = a.positionals;
      const q = qs({ from: a.options.from, outcome: a.options.outcome, submission: a.options.submission, vk: a.options.vk, ...utmQuery(a.options) });
      return renderPublicStep(ctx, (await requestJson(ctx, `${pub(org, slug)}/next${q}`, { auth: false })).body);
    },
  },
};

export async function runFunnels(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'public') return dispatchTable(ctx, 'funnels public', FUNNELS_HELP, PUBLIC, argv.slice(1), '--help');
  return dispatchTable(ctx, 'funnels', FUNNELS_HELP, TABLE, argv, 'list');
}
