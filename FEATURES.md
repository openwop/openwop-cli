# FEATURES.md — @openwop/cli

The catalog of **command groups** in this CLI, and how the **capability-gating**
system that fronts them works. Each command group is a self-contained module
(`src/cli/<group>.ts`) that drives one protocol surface a host exposes — it plugs
into the dispatcher and degrades gracefully when the target host doesn't advertise
the capability it needs.

> **Companion docs:** [`ARCHITECTURE.md`](ARCHITECTURE.md) is the *shape* (layers,
> seams, boundary discipline); this file is the *what* (the surfaces the CLI can
> drive). [`README.md`](README.md) is the end-user guide. The design/scoping
> workflow for surfacing a **new** capability is the `/feature` skill; the
> implement-and-verify loop is `/update-cli`.
>
> The CLI is a **host-agnostic control plane**: it must work against *any*
> OpenWOP-conformant host, not just the reference app. The contract is what
> `/.well-known/openwop` advertises + what `api/openapi.yaml` (in `openwop/openwop`)
> defines — never a host's private internals.

---

## How the capability-gating system works

The CLI has no per-tenant toggle system of its own (that lives in the *host*).
Its analog is **capability-gating**: the host declares which optional surfaces it
serves, and each command group probes for its surface and either drives it or
fails closed with a clear message.

### The host advertises; the CLI gates

`/.well-known/openwop` (read via `openwop capabilities --json`) is the source of
truth for *what a host claims to serve*. A command group that needs an optional
surface should:

- **Probe before it asserts** — use `safeRequest`/`probeEndpoint` (`src/api.ts`),
  not a bare `requestJson` that throws a stack trace when the route 404s.
- **Fail closed, legibly** — when the host doesn't advertise the surface, emit a
  clear `HOST_CAPABILITY_MISSING`-style message ("this host doesn't serve X"),
  never a raw error. Mirror how existing groups handle the missing case.
- **Never pretend** — don't print a fabricated success for a surface the host
  didn't actually honor. Capability honesty is the same rule the host obeys.

### Normative `/v1/*` vs host-extension `/v1/host/openwop-app/*`

Every command targets one of two kinds of route, and **says which in its help text**:

- **Normative `/v1/*`** — protocol-standard surfaces defined in `api/openapi.yaml`
  and backed by an Accepted RFC (e.g. `/v1/runs`, `/v1/agents`). Host-agnostic:
  any conformant host serves these. **Prefer these** when a host serves them.
- **Host-extension `/v1/host/openwop-app/*`** — non-normative surfaces the reference
  app (and lookalike hosts) expose for product features (orgs, kanban, messaging,
  memory, …). Rich and durable, but not part of the wire contract. When a sample
  pattern becomes generally needed, it gets promoted through an RFC and the
  command should switch to the normative path (noting the switch in help + CHANGELOG).

### Auth + base URL are resolved once, from `Ctx`

A command never reads the base URL from the environment or prompts for it inline.
Onboarding (`onboard`/`config`) resolves the host base URL + Bearer key into the
run `Ctx` (`src/context.ts`); every group takes auth and the target host from
`ctx`. Global `--base-url` / `--api-key` overrides are parsed once by
`extractGlobalOptions` (`src/options.ts`) before dispatch.

### Output is dual-surface: human table + `--json`

Every **read** subcommand supports `--json` (machine output via `writeJson`); the
default is a `formatTable` human view (`src/io.ts`). Write/long-running commands
return **meaningful exit codes** so scripts can branch — e.g. `agents run` exits
`0` (completed) / `3` (escalated) / `1` (failed).

### Where it lives (code)

| Concern | Path |
|---|---|
| Entry point (shebang → `runCli`) | `src/openwop.ts` |
| Dispatcher (`switch (command)`, global-option parsing, root help) | `src/cli.ts` → `runCli()` |
| Command groups (the unit of a "feature") | `src/cli/<group>.ts` |
| HTTP to the host | `src/api.ts` (`requestJson`, `safeRequest`, `probeEndpoint`, `parseJsonResponse`) |
| Output | `src/io.ts` (`write`, `writeLine`, `writeJson`, `formatTable`, `prefixChunk`) |
| Arg parsing | `src/options.ts` (`parseOptions`, `extractGlobalOptions`, `splitFlag`, `takeValue`, `toOptionName`) |
| Run context (host, auth, io, config) | `src/context.ts` (`Ctx`) |
| Errors | `src/errors.ts` (`CliError`, `HttpError`, `errText`) |
| Streaming (SSE) | `src/sse.ts` (`submitTurn`, `streamRunEvents`, `consumeSse`, `renderEvent`) |
| Interactive prompts | `src/prompt.ts` (`promptChoice`, `promptText`, `promptYesNo`, `readSecret`) |
| Local config (`~/.openwop/config.json`) | `src/config.ts` |
| Constants (version, default host, provider catalog, host presets) | `src/constants.ts` |
| Daemon/service install (for the `demo` group) | `src/daemon.ts` |
| Relay channel plugins | `src/channels/` (`registry.ts`, `normalize.ts`, `types.ts`) |

---

## Current command groups

Each group is `src/cli/<group>.ts` (exports `<GROUP>_HELP` + `run<Group>(ctx, argv)`)
wired into `src/cli.ts`. "Source" cites the RFC/spec the surface comes from; the
host route is what the subcommands hit.

| Group (aliases) | Source | Host route(s) | Surface / notes |
|---|---|---|---|
| **onboard** | — | (local + provider probes) | Guided first-run wizard: host → provider → model → BYOK key. |
| **doctor** | — | `/health`, `/readiness` | Check local prerequisites + demo reachability. |
| **demo** | — | (local process) | Run/inspect the workflow-engine demo app locally; `install` lays down a LaunchAgent/systemd/Scheduled-Task service (`src/daemon.ts`). |
| **health** | — | `/health`, `/readiness` | Liveness/readiness probe. |
| **capabilities** (`caps`) | — | `/.well-known/openwop` | Read + summarize the host capability advertisement. **This is the gap-discovery entry point.** |
| **catalog** | — | `/v1/host/openwop-app/node-catalog` | List the host node catalog + installed packs. |
| **packs** (`pack`) | C-5 (signed registry) | registry @ `packs.openwop.dev` | Search/info/install (SRI + Ed25519 verify)/publish/yank signed node packs. |
| **workflows** (`workflow`) | — | `/v1/host/openwop-app/workflows` | List/get/register/delete demo workflow definitions. |
| **runs** (`run`) | RFC 0040 (ancestry) | `/v1/runs` (normative) | Create/list/inspect/annotate/debug-bundle; `ancestry` shows the cross-host parent chain. |
| **chat** | — | `/v1/runs` + SSE | Interactive streaming REPL over a workflow (uses `src/sse.ts`). |
| **memory** | — | `/v1/host/openwop-app/memory` | Demo MemoryAdapter list/search/get/delete (tenant-scoped). |
| **media** | `core.openwop.ai` | `/v1/runs` (ai nodes) | generate-image / transcribe / synthesize via the AI pack. |
| **conformance** | — | (in-repo `@openwop/openwop-conformance`) | Run the conformance CLI against a host. |
| **providers** (`provider`) | — | `/v1/host/openwop-app/byok/secrets` | Manage BYOK credential **refs** (never values). |
| **agents** (`agent`) | RFC 0070 | `/v1/agents` + `/v1/host/openwop-app/agents` | Manifest-agent inventory + dispatch; CRUD for user-defined agents. Exit codes `0`/`3`/`1`. |
| **roster** | RFC 0086 | `/v1/host/openwop-app/roster` | Named standing agents + their workflow portfolio. |
| **org-chart** (`orgchart`) | RFC 0087 | `/v1/host/openwop-app/org-chart` | Descriptive department/role/reporting structure. |
| **kanban** (`boards`) | host-extension (composes RFC 0086 triggers) | `/v1/host/openwop-app/kanban` | Agent task boards; `watch` streams card events. |
| **orgs** (`org`) | RFC 0049 | `/v1/host/openwop-app/orgs` | Orgs/teams/groups/roles/members RBAC; `effective` resolves a subject's access. |
| **workspace** | RFC 0059 §C | `/v1/host/openwop-app/workspace` | Per-tenant agent workspace files (list/put/get). |
| **byok** | — | `/v1/host/openwop-app/byok/secrets` | Host-side BYOK secret store; the wire **never returns values**. |
| **config** | — | (local file) | Read/write `~/.openwop/config.json`. |
| **webhooks** (`webhook`) | — | `/v1/host/openwop-app/webhooks` | Manage HMAC-signed webhook subscriptions; `test` fires a signed delivery. |
| **cron** | RFC 0052 | `/v1/host/openwop-app/scheduler/jobs` | Scheduled jobs: list (--roster filter) / add / enable / disable / remove / trigger. |
| **messaging** | host-extension | `/v1/host/openwop-app/messaging` | Operate the demo relay-gateway: connectors, sessions, policy, routing, identity, logs. |
| **relay** | host-extension | (local bridge loop) | Local channel relay: register/activate + the inbound→workflow bridge across channel plugins. |
| **notifications** (`notification`) | host-extension | `/v1/host/openwop-app/notifications` | Notification inbox. |
| **interrupts** (`interrupt`) | — | `/v1/host/openwop-app/runs/:id/interrupts` | List a run's open interrupts; resolve one by token. |
| **prompts** (`prompt`) | RFC 0029 | `/v1/host/openwop-app/prompts` | Prompt-library list/get/render. |
| **notify** | — | `/v1/host/openwop-app/notify` | One-off email/SMS dispatch via the demo host. |
| **account** | — | `/v1/host/openwop-app/account` | Tenant self-service hard-delete. |
| **admin** | — | `/v1/host/openwop-app/admin` | Operator maintenance (ephemeral-secret cleanup). |
| **governance** (`policy`) | ADR 0028 | `/v1/host/openwop-app/governance` | Tenant policy (provider allowlist / per-action policy / retention) + audit read view. Renders the host's resolved view only — never evaluates policy locally; fails closed if the surface isn't advertised. |
| **approvals** (`approval`) | — | `/v1/host/openwop-app/approvals` | Approval inbox (agents propose, humans dispose): list/get + claim/reject. Renders the host's verdict; never decides locally. |
| **consent** | ADR 0020 | `/v1/host/openwop-app/consent/orgs/:orgId/*`, `/v1/host/openwop-app/public-consent/:orgId` | Tenant-scoped consent: policy get/set, records list/get, GDPR erase + public (unauthed) read/record. Renders the host's resolved view; fails closed on the uniform 404 when the `consent` toggle is off. |
| **mcp** | RFC 0020 | `/v1/host/openwop-app/mcp` (JSON-RPC) | MCP client for the host's JSON-RPC server mount: `info`/`ping` + `tools`/`resources`/`prompts` list/call/read/get. Mount is host-env-gated (OFF by default) — commands fail closed legibly when it's not exposed. |
| **connections** (`conn`) | ADR 0024 | `/v1/host/openwop-app/connections` | Third-party connections: list/get/test + authorize-URL + oauth-clients list/get. Surfaces refs/status only — secrets stay host-side (recursive redactor); never completes OAuth. |
| **profiles** | ADR 0005 | `/v1/host/openwop-app/profiles`, `/profiles/{me,:userId}`, `/me/{skills,portfolio,pinned-agents,activity}`, `/:userId/skills/:skill/endorse` | Self-service persona: list/get, self-edit, skills, portfolio, pin/unpin agents, peer endorsements, activity feed. Reads visible to tenant members; writes self-only. Persona surface — NOT the user directory or RBAC. |
| **toggles** | host-extension (ADR 0001 §3) | `/v1/host/openwop-app/feature-toggles/assignments` | Render the caller's host-resolved feature-toggle assignments (`list`/`get`): status (on/off/beta), enabled, variant + bindings. Read-only — the host resolves; the CLI never computes/overrides a toggle decision, and doesn't author config. Fails closed if not served. |
| **users** | ADR 0002 | `/v1/host/openwop-app/users` | Tenant identity directory + account lifecycle: list/get/create/update, disable/enable, delete, and `me`. Mirrors the `source` enum + raw IdP `groups[]`. Directory + lifecycle only — not RBAC (`orgs`) or persona (`profiles`); fails closed (404 not served, 403 disabled). |
| **workforces** (`fleet`) | — | `/v1/host/openwop-app/workforces` | Governed Workforce: list/get + metrics/governance/migration/trace/shadow reads + status cutover + eval. Durable multi-agent orchestration; composes with kanban/roster, never re-models them. |
| **auth** (`sso`) | RFC 0050 | `/v1/host/openwop-app/auth/saml/{sso/metadata,sso/login,validate}`, `/auth/scim/provision` | Enterprise SSO/SAML/SCIM identity config: status (advertised profiles), SP metadata, IdP login URL, SAML-assertion validate seam, SCIM provisioning seam. Surfaces status/metadata only — certs/bearers/secrets stay host-side (recursive redactor); fails closed when a surface isn't configured. NOT users/orgs/byok. |
| **analytics** (`usage`) | ADR 0018 | `/v1/host/openwop-app/analytics/orgs/:orgId/{summary,events}`, `/public-analytics/:orgId/collect` | Org-scoped usage analytics: `summary`/`events` (host-aggregated, RBAC `workspace:read`) + public consent-gated `collect` beacon (unauthed; 202 = consent not granted). Renders the host's rollup, never computes locally. Usage/cost/observability — distinct from `governance audit`. |
| **proposals** | RFC 0096 | `/v1/host/openwop-app/proposals` | Reviewable-learning proposal lifecycle: list/get + revise (PATCH, never activates) / apply (host materializes the stored draft via its activation mode) / reject / archive. Renders the host's verdict; never activates locally. Exit `0` applied / `3` pending / `1` rejected\|error. |
| **goals** | RFC 0097 | `/v1/host/openwop-app/goals` | Standing goals with judge-based completion: list/get + create (judge/continuation/bounds; 422 if requiresBounds) / pause / resume / abandon. Completion is the host judge's verdict — no `satisfy` verb, CLI never sets satisfied. Exit `0` satisfied / `3` escalated\|open / `1` bound-exceeded\|abandoned\|error. |
| **export** / **import** | RFC 0098 | `/v1/host/openwop-app/{export,import}` | Agent-platform portability: `export [--kinds --out]` → refs-only bundle; `import <file> [--dry-run]` → no-write plan then idempotent apply (re-owned host-side). Secrets are refs, never values (host 422s literal credentials; CLI redacts all output). Import exits `0` applied / `2` plan-has-conflicts / `1` error. |
| **triggers** | RFC 0099 | `/v1/trigger-subscriptions` (normative) | External-event trigger subscriptions: `register --source <webhook\|email\|form> --workflow <id> [--dedup --verification]` / `list` / `get`. Binds a source→workflow; renders the created subscription + source binding (secret shown once, never persisted; re-reads show the fingerprint). Capability-gated on `triggerBridge` (+ `ingestion.externalSources` for register). Exit `0` active / `3` paused / `1` failed\|dead-lettered. |
| **a2a** | RFC 0100 | `/v1/host/openwop-app/a2a/tasks/{taskId}` | Async/durable A2A tasks: `a2a status` (advertised `capabilities.a2a`) + `a2a task <id>` reads the durable `A2ATaskState` (taskId === runId; content-free projection). Gated on `capabilities.a2a.durableTasks`. Exit `0` completed / `3` in-progress / `1` failed\|canceled\|rejected. |
| **documents** (extended) | ADR 0053/0057/0083 | `/v1/host/openwop-app/documents/orgs/:orgId/*`, `/documents/locate/:id`, `/artifacts/:id/*` | Documents + versions, templates (catalog/from-catalog/assemble/update), canvas sources, from-canvas, promote-html, ingest-to-kb, render `--format`; `documents artifacts` get/revisions/revision/diff. |
| **docs** | ADR 0392 | `/v1/host/openwop-app/docs/orgs/:orgId/backfill` | Re-sync published product docs into the knowledge base; `public <orgId>` reads the published list. |
| **notebooks** (extended) | ADR 0084 | `/v1/host/openwop-app/notebooks/*` | ensure; notes; sources (text/file/audio/YouTube as base64 JSON; summarize/transform/context-level); transformations + templates; grounded chat; search. |
| **podcasts** (extended) | ADR 0086/0390 | `/v1/host/openwop-app/podcasts/*` | Episodes (publish/unpublish/retry), shows (CRUD + publish), episode-profiles, speaker-profiles. `list` now needs `--org` (the host requires `orgId`). |
| **knowledge-sync** | ADR 0107 | `/v1/host/openwop-app/knowledge-sync/*` | Browse a connection's folders; create/get/update/pause/resume/sync/delete a sync source. |
| **media** (extended) | ADR 0007/0352/0363/0401, RFC 0055 §C | `/v1/host/openwop-app/media/orgs/:orgId/*`, `/media/{upload,put}`, `/assets/:token` | Media library assets/collections/image-providers, AI generate/edit/upscale, alt-text/autotag proposals; local-file `upload`/`put` (base64 JSON) and `fetch <token> --output`. |
| **entities** | ADR 0386/0406/0407 | `/v1/host/openwop-app/entities/*`, `/public-entities/:tenantId/*` | Custom entity types (query/export/import NDJSON), records, taxonomies + terms (reorder), relationships, locale context, anonymous `public` reads. |
| **creative-briefs** | ADR 0353/0399/0411 | `/v1/host/openwop-app/creative-briefs/orgs/:orgId/*` | Briefs CRUD, transition, versions/diff, moodboard, `pdf --output`, async `reel`, render-templates, renders. |
| **creative-video** | ADR 0404 | `/v1/host/openwop-app/creative-video/orgs/:orgId/*` | Video jobs list/get, avatar `generate`, `text-to-video`. |
| **production** | ADR 0172/0643 | `/v1/host/openwop-app/production/orgs/:orgId/*` | Plans list/get/status; vendors CRUD + portfolio (add/remove read-modify-write); reindex-kb. |
| **tutorials** | ADR 0488 | `/v1/host/openwop-app/tutorials*` | Tutorial library + your progress. |
| **walkthroughs** | ADR 0378 | `/v1/host/openwop-app/walkthroughs/{progress,funnel}` | Walkthrough progress get/set + the run-derived funnel. |
| **widgets** | reference example domain | `/v1/host/openwop-app/widgets*` | list/summary/create/archive/seed; mounted only with `OPENWOP_EXAMPLE_WIDGETS_ENABLED=true`. |
| **ui-state** | ADR 0071 | `/v1/host/openwop-app/ui-state` | Per-resource saved UI preferences: list/get/set/delete. |
| **ui-plugin** | RFC 0117 / ADR 0367 | `/v1/host/openwop-app/ui-plugin/*`, `/v1/host/sample/ui-plugin/rpc` | Plugin packs, sandboxed/trusted entry bundles (`--output`), demo artifact, `ui-plugin/1` rpc. |
| **canvas-collab** | ADR 0359 | `/v1/host/openwop-app/canvas-collab/*` | Collaboration ticket (shown once), seeder claim, room debug (super-admin). |
| **workflow-collab** | ADR 0481 | `/v1/host/openwop-app/workflow-collab/*` | Workflow-builder multiplayer ticket + seeder claim. |
| **canvas-packs** | ADR 0314 | `/v1/host/openwop-app/canvas-packs/orgs/:orgId/types` | Editable canvas types from installed canvas packs. |
| **present** | ADR 0328 | `/v1/host/openwop-app/present/:token/*` | Presentation remote by token: outline/command/state + follow the `nav` event stream. |
| **sharing** (extended) | ADR 0328 P7 | `/v1/host/openwop-app/shared/:token/{card,frame-view}` | Public `card` / `frame-view` (no auth) + owner `frame-views` analytics. |
| **commerce** | openwop-app ADRs 0178/0188 (UCP), commerce | `/v1/host/openwop-app/commerce/orgs/:orgId/*`, `/commerce/ucp/orgs/:orgId/*`, `/public-store/:orgId/*` | Catalog, product fields, price lists, cart, orders (pay/refund/cancel/fulfilment), quotes, subscriptions, coupons, affiliates (+ payouts CSV), reports; UCP seller agent-commerce + buyer; `public` storefront (no auth). Stripe webhook receiver not driven (server-to-server). |
| **commerce-connect** | openwop-app ADR 0385 | `/v1/host/openwop-app/commerce-connect/*` | Stripe Connect paid listings: seller status + hosted onboarding link, listings, purchase checkout, orders, payouts, approvals, superadmin refunds/disputes/delist/fee-config. Never card/bank data. |
| **promotions** | openwop-app ADR 0274 | `/v1/host/openwop-app/promotions/orgs/:orgId/promotions` | Promotion CRUD (threshold / product / loss-leader / tiered / BOGO); evaluation stays host-side. |
| **recommendations** | openwop-app ADR 0273 | `/v1/host/openwop-app/recommendations/orgs/:orgId/*`, `/public-recommendations/:orgId/resolve` | Placements CRUD, affinity rebuild, resolve (+ public resolve, no auth). |
| **dealers** | openwop-app ADR 0281 | `/v1/host/openwop-app/dealers/orgs/:orgId/*`, `/partner/:token` | Dealers, outlets, registrations, portal-token mint (shown once); public partner portal get/register. |
| **commissions** | openwop-app ADR 0280 | `/v1/host/openwop-app/commissions/orgs/:orgId/*` | Commission plans + statements: compute, approve (approval-gated, 202), pay. |
| **territories** | openwop-app ADR 0272 | `/v1/host/openwop-app/territories/orgs/:orgId/*` | Territory types, models (activate/archive/preview/quotas/attainment), territories, rules, quotas, active model, reassignment. |
| **sales-maps** | openwop-app ADR 0282 | `/v1/host/openwop-app/sales-maps/orgs/:orgId/geocode` | Geocode an address / coordinates. |
| **crm** (extended) | openwop-app ADR 0008 + CRM ADRs | `/v1/host/openwop-app/crm/*`, `/public-book/*`, `/public-sign/*` | Adds contact score/convert/merge/identifiers, fields, segments, suppressions, duplicates, export, merge events, gmail-sync, and the org surface: companies, deals, pipelines, tasks, activities, import/export, booking links, sign requests, public book/sign (no auth). |
| **brand-kits** | ADR 0155 / 0399 | `/v1/host/openwop-app/brand/{channels,brands[/:id[/audit\|/fonts[/:role]]]}` | Marketing brand kits (voice, guardrails, governance lock, custom fonts, change audit). Distinct from **brand** (the white-label app identity at `/public-brand` + `/app-brand`); each help cross-references the other. Governance-gated writes render the host's 403. |
| **campaign-brief** | ADR 0156 | `/v1/host/openwop-app/campaign-brief/{buyer-stages,personas,briefs,hooks}` (+ `briefs/:id/{validate,duplicate,versions,voc,angles,targeting}`) | Personas + briefs CRUD, validation, versions, VoC evidence, angles, targeting packs, hook bank promote. |
| **campaign-connectors** | ADR 0159 | `/v1/host/openwop-app/campaign-connectors/*`, `/public/:orgId/{pixels,conversions}` | Ad-platform metrics sync, audience sync, CSV import, records/KPIs, sync status, pixels + server-side conversions; `public` legs are unauthed and consent-gated host-side. |
| **campaign-intel** | ADR 0160 | `/v1/host/openwop-app/campaign-intel/*` | Budget optimizer + planner, anomalies, overview, attribution, pacing, forecast; `apply` changes live spend so it needs `--yes` unless `--dry-run`. |
| **campaign-journeys** | ADR 0222 | `/v1/host/openwop-app/campaign-journeys/enrollments` | Journey enrollment ledger + explicit re-enrollment reset (`--yes`). Sibling of **campaigns-orchestration**. |
| **cdp** | ADR 0263 | `/v1/host/openwop-app/cdp/*` | Identity resolve, event schemas (register/validate — 422 renders errors, exit 1), collect/batch/CSV import, collected/merge events, governance decisions, audit-chain verify (exit 1 when broken). |
| **destination-sync** | ADR 0266 | `/v1/host/openwop-app/destination-sync/syncs[/:id[/dry-run\|/prepare\|/advance]]` | Reverse-ETL syncs: list/create/get/update/delete + field-map dry-run, batch prepare, cursor advance. |
| **discovery** | ADR 0275 | `/v1/host/openwop-app/discovery/orgs/:orgId/*`, `/public-discovery/:orgId/search` | Collections, merch rules, product search (+facets), embeddings rebuild; `public search` is the unauthed storefront read. |
| **funnels** | ADR 0294 / 0330 | `/v1/host/openwop-app/funnels/orgs/:orgId/funnels/*`, `/public/:orgId/funnels/:slug[/steps/:ix\|/next]` | Funnel lifecycle (publish/unpublish/archive), stats + rebuild, step A/B experiments; `public view/step/next` drive the visitor flow unauthed. |
| **webinars** | ADR 0404 | `/v1/host/openwop-app/webinars/orgs/:orgId/events[/:id/{bind-form,sync,push-registrants}]` | Webinar events with registrant/attendee counts; bind a form, pull provider sync, push queued registrants (exit 1 on any failure). |
| **public** | ADR 0012 / 0027 / 0390 / 0392 / 0419 | `/v1/host/openwop-app/public/:orgId/{pages,blog,feed.rss,sitemap.xml,robots.txt,llms.txt,prerender,podcasts…}`, `/public/{pricing,bundle-pricing}` | Every anonymous published surface, sent without a bearer: JSON reads render tables; XML/RSS/Markdown/HTML print verbatim (`--json` wraps `{status,contentType,body}`); `audio` probes type/size or `--out` downloads. **email/forms/chat-widget** gained `public` legs (tracking pixel, click redirect reported not followed, unsubscribe/preferences behind `--yes`, provider bounce webhook replay; public form get/submit; widget config/message/embed.js). |
| **vault** | openwop-app ADR 0024 / 0176 | `/v1/host/openwop-app/vault`, `/vault/secrets[/:ref[/rotate]]` | Super-admin secrets vault: ref inventory (tenant + host-global secrets, connections, OAuth clients, developer keys), set / rotate (value from file or no-echo prompt) / delete. **Never** reveals — the host's `/reveal` route is intentionally not driven. Exit 4 without super-admin. |
| **developer-keys** | openwop-app ADR 0270 | `/v1/host/openwop-app/developer-keys[/:id]` | Developer API keys: list, create (token printed once with a warning), revoke. |
| **custom-domains** | openwop-app ADR 0295 | `/v1/host/openwop-app/custom-domains/orgs/:orgId/domains[/:hostname[/verify]]` | Custom hostnames for an org's published pages; `verify` exits 3 until live. |
| **environments** | openwop-app ADR 0383 / 0387 | `/v1/host/openwop-app/environments/*` | Config environments: list (+drift), create, ensure-chain, protection, settings (approval gate), snapshots, preview, promote / rollback / apply (exit 3 when queued for approval), promotions ledger. |
| **billing** | openwop-app ADR 0176 / 0419 | `/v1/host/openwop-app/billing/*` | Subscription, balance, entitlements, bundles, invoices; checkout / bundle-checkout / portal return Stripe-hosted URLs (no card data); super-admin import / sync-seats / coupons / invoice create. Webhook not driven (Stripe-to-server). |
| **site-config** | openwop-app ADR 0487 | `/v1/host/openwop-app/{public-site-config,site-config}` | System-site switch: anonymous `public` read; super-admin get/set. |
| **runtime-posture** | openwop-app ADR 0742 | `/v1/host/openwop-app/runtime-posture[/change-requests]` | Super-admin: live warm/cold posture; a change request returns the commands to run and applies nothing. |
| **maintenance** | openwop-app ADR 0006 | `/v1/host/openwop-app/maintenance/rekey-member-subjects` | Super-admin: re-key legacy org-member subjects to durable user ids. |
| **menu-config** | openwop-app navigation-settings | `/v1/host/openwop-app/menu-config[/me\|/tenant]` | Navigation menu layout: get; replace your personal layer; super-admin replace of the workspace default (If-Match guarded). |
| **orgs** (extended) | RFC 0049 + openwop-app ADR 0015 | `/orgs/:orgId/invites`, `/orgs/invitations/*`, `/authorization/decide`, `…/transfer-ownership` | Invites (list/create/revoke), invitee preview/accept/decline, the fail-closed decision seam (exit 0 allowed / 1 denied), ownership transfer; `effective --member/--org`; `roles list` includes custom roles. |
| **users** (extended) | openwop-app ADR 0002 / 0621 | `/users/me/security[/factor-event]`, `/users/me/sessions/revoke`, `/users/users/:id/sessions/revoke`, `/users/auth/{logout,oidc/bind}` | Session + MFA legs: security posture, authenticator notice, sign-out-everywhere (self + admin), logout, OIDC bind. |
| **governance** (extended) | openwop-app ADR 0178 / 0187 / 0416 | `/governance/{egress-rules,byok-chat-budget,audit/export}` | Egress firewall rules, BYOK chat token cap, audit CSV/JSONL download, tamper-evident audit-chain export; policy set gains the live retention windows + `--require-mfa` + `--body`, and prints the host's warnings. Exit 4 without super-admin. |
| **toggles** (extended) | openwop-app ADR 0434 | `/feature-toggles/admin/{configs[/:id],features,env-governed}` | Super-admin config: list / get / features / env-governed / set (read-modify-write) / reset. |
| **byok** / **admin** / **auth** / **brand** / **analytics** / **workspaces** (extended) | openwop-app ADRs 0711, 0371, 0010, 0511, 0018, 0015 | `/byok/active-config`, `/admin/run-retention[/hold]`, `/auth/break-glass`, `/app-brand/assets`, `/usage/orgs/:orgId/rollup`, `/migrate-tenant` | Chat binding get/set/clear; run-retention posture + legal holds (admin token); break-glass login (token from file/prompt); raster brand-asset upload; AI usage rollup (unknown cost shown as `?`); move an anonymous session into your account. |
| **agents** / **roster** / **org-chart** (normative reads) | RFC 0072 §A · RFC 0086 · RFC 0087 §D | `GET /v1/agents[/{agentId}]`, `/v1/agents/roster`, `/v1/agents/org-chart[/{departmentId}]` → fallback `/v1/host/openwop-app/{agents,roster,org-chart}` | Reads prefer the normative operation; fall back on 404/405/501; `--host` forces the host path; `--verbose` names which answered. `agents eval-run` (RFC 0081) + `verify-run` (RFC 0090) drive the host seams. |
| **content** | RFC 0103 (`localized-content.md`) | `/v1/content/pages[/{slug}\|/{pageId}[/sections/{sectionId}]]`, `/v1/content/settings` | Normative localized content: public `page` delivery (`--locale` → Accept-Language), `pages`, `create`, `delete`, `section`, `settings`. 501/404 fail closed (exit 1). |
| **agent-knowledge** | openwop-app ADR 0038 / 0041 | `/v1/host/openwop-app/agents/{id}/knowledge/*` | Per-agent knowledge: show, retrieve, bind/unbind, create-collection, ingest, import (from a connection), delete-document, notes, add/delete-note, memory-writable. |
| **compat-endpoints** | RFC 0108 · openwop-app ADR 0121 | `/v1/host/openwop-app/compat-endpoints[/{id}]` | Org self-hosted / OpenAI-compatible model endpoints; key sent once from a file/env var, never shown. Disabled surface → exit 1. |
| **host-events** | openwop-app ADR 0208 | `/v1/host/openwop-app/host-events/bindings[/{id}]` | Bind `host.*` events to workflows; enable/disable/unbind. |
| **client-support** | openwop-app ADR 0413 | `GET /v1/host/openwop-app/client-support` | Min-supported-build handshake (public); exit 3 when below the floor. |
| **dispatch** | RFC 0118 | `POST /v1/host/openwop-app/dispatch/fanout` | Parallel fan-out join witness; exit 0 only when the join is satisfied. |
| **openapi** | `api/openapi.yaml` getOpenApi | `GET /v1/openapi.json` | Fetch/save the served OpenAPI document; `paths` lists its operations. |
| **runs** / **interrupts** / **webhooks** / **catalog** (extended) | idempotency.md · RFC 0093 · RFC 0201 · RFC 0188 · RFC 0003 | `/v1/runs/{id}/effects`, `/v1/runs/{id}/interrupts/{nodeId}`, `/v1/interrupts/{token}` (GET), `/v1/webhooks/{id}/rotate-secret`, `/v1/webhooks/{id}/dead-letters`, `/v1/packs/-/search`, `/v1/packs/{name}`, `/v1/packs/export`, host `…/runs/{id}/revision`, `…/runs/{id}/pin`, `…/runs/redrive` | `runs effects/revision/pin/unpin/redrive`, `interrupts inspect/respond`, `webhooks rotate-secret/dead-letters`, `catalog packs search/get/export`. |
| **workflows** / **approvals** / **reviews** / **prompts** / **agent-profile** (extended) | openwop-app ADRs 0369/0474–0480, 0198/0478, 0068, 0116, 0373 | `/v1/host/openwop-app/workflows/{id}/{archive,unarchive,promote,revisions,rollback,estimate,pins,debug-run,eval-sets,eval-results}`, `…/workflows/stats`, `…/approvals/{sla-policy,email-pref}`, `…/approval-delegations`, `…/reviews/{id}[/actions/{a}]`, `…/prompts/orgs/{org}/entries[/{id}[/render]]`, `…/agents/{id}/capabilities/{cap}` | Workflow lifecycle/revisions/debug pins/eval sets; approval SLA + email pref + delegations (+ `--acted-for`/`--expected-hash`); review filters + `--value-json`; the org prompt library; capability election. |
| **chat** (extended) | RFC 0005; openwop-app ADR 0043/0071/0102/0112/0119/0124/0132/0195 | `/v1/host/openwop-app/chat/*`, `/chat-export/*`, `/conversation-tools/sessions/:id/*` | ONE chat group: the REPL (`chat <workflowId>`) plus the persistent conversation primitive — sessions (create/get/rename/delete/branch/read/board/bind-run), messages (paged list/send/edit/delete/react), participants, 1:1 `open`, feedback, model picker, full-text `search`, `export`/`import`, per-conversation tool scope (read-modify-write) + tool approvals. |
| **assistant** | openwop-app ADR 0023/0025/0029/0662 | `/v1/host/openwop-app/assistant/*` | Executive-assistant work graph: workspace conversation, briefing, projects, commitments, decisions, meetings, stakeholders, drafted-action queue (approve requires the reviewed `--content-hash`), perception loops, health. |
| **channels** | openwop-app ADR 0126/0154/0192/0202, RFC 0110 | `/v1/host/openwop-app/channels/*` | Team channels: list/create/get/update/archive/join/leave, messages + post, live `stream` (server-sent events), members, agent members + reply policy, AI `catchup`, presence stream/snapshot/typing. |
| **scheduled-chats** | openwop-app ADR 0125/0202 | `/v1/host/openwop-app/scheduled-chats/{orgs/:orgId,channels/:channelId}/chats` | Scheduled agent chats in org or channel scope: list/get/create/pause/resume/delete. |
| **voice** | RFC 0105/0106; openwop-app ADR 0109/0138 | `/v1/host/openwop-app/voice/session/*`, `/voice/realtime/*`, `/voice/barge-in` | Walkie-talkie sessions (audio file → base64 chunks, commit, speak, barge-in, close) + realtime bridge (capability, operator config read-modify-write, session with the ephemeral token redacted unless `--reveal-token`, SDP connect, tool-call, held-approval resolve, transcript stream) + the barge-in demo seam. |
| **ai** | RFC 0091/0105/0106/0108/0121 | `/v1/host/openwop-app/ai/{call,call-speech-synthesizer,call-transcriber}`, `/credentials/bind` | AI-provider seams: modality-gated `call`, `speech`, `transcribe`, and the user-scope-only subscription `bind-credential` (value read from a file/env, never argv; only the ref is printed). |
| **a2a** (extended) | RFC 0100/0152 | `/v1/host/openwop-app/a2a`, `/a2a/{invoke,tasks/start,tasks/push-config}` | Adds `rpc` (one JSON-RPC 2.0 call + `A2A-Version` header), `start` (sample durable task), `push-config`, and the `invoke` negotiation seam. |
| **notifications** (extended) | host-extension | `/v1/host/openwop-app/notifications/{stream,push/*}` | Adds the live `stream` and web-push `config`/`list`/`subscribe`/`unsubscribe`. |
| **computer-use** | openwop-app computer-use | `/v1/host/openwop-app/computer-use/orgs/:orgId/sessions[/:id]` | Browser-agent sessions + step log (read-only). |
| **whatsapp** | openwop-app WhatsApp | `/v1/host/openwop-app/whatsapp/orgs/:orgId/{health,attestation}` | Business connection health + the no-training attestation (get/set/revoke). |
| **agent-author** | openwop-app ADR 0058 | `/v1/host/openwop-app/agent-author/draft` | Read / clear the agent draft the AI Agent Architect stashed for you. |
| **workflow-author** | openwop-app ADR 0072/0472/0595/0596 | `/v1/host/openwop-app/workflow-author/{catalog,draft}` | Authoring node catalog + draft a workflow from an intent (`--follow` streams the run). |
| **workflow-proposals** | openwop-app ADR 0473 | `/v1/host/openwop-app/workflow-proposals/admin/policies/*` | Operator auto-approval policies for agent-proposed workflows (list/enable/disable). |

> **Channel plugins** (used by `relay` + `messaging`): the inbound/outbound
> normalizers for **Signal, iMessage, WhatsApp, and Discord** live in
> `src/channels/` and are re-exported from `cli.ts` so the built bundle is testable.
> A new channel is one entry in the channel registry + a normalizer — it is *not* a
> new command group.

---

## Adding a command group

A new command group is wired by **adding a module + one dispatcher case** — no
rewrite of the dispatcher or other groups (read `src/cli/agents.ts` first; it is
the canonical example). The full contract is the `/feature` skill's evaluation
matrix; the mechanical steps:

1. **Module** — create `src/cli/<group>.ts`:
   - a top-of-file docblock citing the RFC/spec the surface comes from (e.g.
     `/** `openwop <group> ...` — <one-line> (RFC NNNN). */`),
   - `export const <GROUP>_HELP` — a `Usage:` block, a normative-grounded prose
     paragraph (which endpoint + which RFC §), per-flag docs, **meaningful exit
     codes**, and `Examples:`,
   - `export async function run<Group>(ctx: Ctx, argv: string[]): Promise<number>`
     — reads `argv[0]` as the subcommand, dispatches, returns an exit code.
   - Use the shared helpers (`requestJson`/`safeRequest`, `formatTable`, `writeJson`,
     `parseOptions`); **don't hand-roll** HTTP, formatting, or arg parsing. Take
     auth + base URL from `ctx`.
   - **`--json` on every read**; capability-gate gracefully; mirror the host
     route's field names / required-optional / enums **exactly** (the CLI is a
     reference client — a wrong field name teaches implementers wrong).
2. **Dispatcher** — wire it into `src/cli.ts`:
   - add `import { run<Group>, <GROUP>_HELP } from './cli/<group>.js';` by the
     other group imports,
   - add a `case '<group>':` (and any alias, e.g. singular) to `switch (command)`,
   - add the group to the `ROOT_HELP` command index.
3. **Docs** — add the group to the `README.md` command reference.
4. **Tests** — add `test/<group>.test.mjs` (or extend `operator-apis.test.mjs`);
   exercise both the human and `--json` paths. Pure normalizers that the bundle
   needs at test time get re-exported from `cli.ts` (see the `channels/*`
   re-exports).
5. **Verify** — `npm run typecheck` + `npm test` (build is part of `test`) green,
   **and** a live smoke against a running host: `onboard` → `capabilities` →
   `<group> list` → `<group> list --json` → a write path where one exists.
6. **Version + CHANGELOG** — add a `CHANGELOG.md` entry; bump `package.json` if the
   change ships a release (independently versioned at 0.x, NOT pinned to the corpus).

### House rules that bite

- **Option-key gotcha.** `parseOptions` camelCases on hyphens: `--agent-ref` ⇒
  `options.agentRef`, `--no-validate` ⇒ `options.noValidate`. Reading the
  *hyphenated* key (`options['agent-ref']`) silently returns `undefined` — always
  read the camelCase key.
- **Zero runtime deps.** The CLI bundles to a single file (`esbuild
  --packages=external`) and ships **no dependencies** — only `@types/node`,
  `esbuild`, `typescript` are dev deps. Use Node stdlib + the `src/*` helpers; never
  add an npm dependency.
- **No user-facing jargon.** Spell out "server" / "frontend" in help and output;
  BE/FE abbreviations are for code comments only.
- **zsh smoke gotcha.** The dev shell is zsh, which does **not** word-split
  unquoted `$var` — a loop like `for c in "roster list"; do openwop $c; done` passes
  one argv token. Use `${=c}` or call each command explicitly. Unauthenticated live
  requests get a throwaway `anon:<sid>` tenant per invocation, so validate a write by
  asserting its `201`, not a follow-up `list`.

---

## ⚠ Spec changes require an RFC — the CLI is a reference *client*, not a fork of the protocol

If a new surface needs anything on the OpenWOP **wire** — a new run-event field,
capability flag, event type, endpoint contract, auth/scale profile, or a normative
`MUST` — that change belongs in the **`openwop/openwop` RFC process** (`RFCS/`,
from `0000-template.md`) and must reach at least `Accepted` *before/with* a CLI
command that depends on it. Do **not** bake a command against an unsettled wire
contract — surface that as a decision (the `/feature` skill's RFC gate). A command
that rides an **already-Accepted** RFC needs no new RFC (e.g. `agents` implements
RFC 0070). Host-extension surfaces under `/v1/host/openwop-app/*` are non-normative and
never touch the wire, so they never need an RFC.

---

## Future / candidate command groups (placeholder)

Capabilities a host advertises (or reference-app routes) that the CLI does **not**
yet drive land here first, then move up to **Current command groups** once shipped.
Discover them with `openwop capabilities --json` (advertised-but-undriveable) and by
diffing the reference-app route table (`openwop/openwop-app`
`backend/typescript/src/routes/`) against the dispatcher's `case` list. Keep the
group name stable across the move.

<!-- Template row:
| **<group>** (`<alias>`) | RFC NNNN | `/v1/.../...` | <one-line surface>. |
-->

> The `/feature` skill (Mode A) auto-builds this gap inventory and scopes the next
> group; `/update-cli` implements it. Keep this table and the `README.md` command
> reference in lockstep when a group ships.
