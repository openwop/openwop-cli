# Changelog

All notable changes to `@openwop/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the CLI is independently
versioned on its own SemVer line.

## [Unreleased]

### Added
- **Identity, RBAC and operator-administration coverage (batch b2).** 9 new groups — `vault` (super-admin secrets vault: refs only, set/rotate from a file or no-echo prompt, delete; reveal deliberately not driven), `developer-keys` (token shown once), `custom-domains`, `environments` (snapshot / preview / promote / rollback / apply; exit 3 when queued for approval), `billing` (reads + Stripe-hosted checkout/portal URLs, super-admin import/coupons/seats/invoices), `site-config`, `runtime-posture`, `maintenance`, `menu-config`. Extended `orgs` (invites, invitations accept/decline/preview, `decide` — the RFC 0049 decision seam, transfer-ownership, `effective --member/--org`, custom roles in `roles list`, members create without `--subject`), `users` (me security / factor-event / sign-out-everywhere, revoke-sessions, logout, oidc-bind), `governance` (egress-rules, byok-chat-budget, audit `--format`, audit-export, media-budget `--images/--video-jobs`), `toggles admin` (list / get / features / env-governed / read-modify-write set / reset), `byok active-config`, `admin run-retention` (+ legal holds), `auth break-glass`, `brand asset`, `analytics rollup`, `workspaces migrate-anon`.
- Super-admin, admin-token and scope-gated surfaces in these groups fail closed with ONE actionable message and exit 4 (`src/cli/adminShared.ts` `gatedRequest`), echoing the host's hint.

### Fixed
- `governance policy set --retention-graph-days/--retention-source-days` set two windows the host no longer enforces (it strips them and warns). Added `--retention-pii-days` / `--retention-internal-days` (the windows the host's sweep enforces) and the command now prints the host's `warnings`; the old flags are marked deprecated in help.
- `governance media-budget` and the other governance reads/writes now map a 403 to the super-admin message (exit 4) instead of a bare `HTTP 403`.

### Fixed — v2 client compliance (audit against `spec/v2/core/*`, corpus `v2.42.6`)
- **Tenant-bound run ids now travel in the projected wire form under major 2** (`identity.md` §5). A `<tenantId>/<id>` run id was sent as `acme%2Fr1`; a front door that decodes `%2F` before routing (app.openwop.dev's does) split it into two segments and answered `404`. Every `/runs/{runId}…` path (incl. `:fork`, `:diff` and `against=`) now sends `acme~2Fr1` — measured live: `%2F` → 404, `~2F` → 200. Already-projected ids pass through; under major 1 nothing changes. (`src/ids.ts`, one call in `resolveRequest`.)
- **The poll cursor is `afterSequence` under major 2** (`events.md` §Poll — "`lastSequence` and `since` are not parameters"). `runs events --since N` and the SSE-fallback poller sent `lastSequence`, which a v2 host ignores, so every poll replayed from sequence 0. Terminal detection reads v2 `isTerminal` as well as v1 `isComplete`.
- **`interrupts resolve` sends the closed `{ "resumeValue": … }` body** both majors' OpenAPI require; it sent the raw `--data-json` object. A payload that is already exactly `{ "resumeValue": … }` is not double-wrapped.
- **Error messages read the error envelope** (`errors.md`): `HTTP 404 not_found: <message>` instead of `HTTP 404: <message>` — the registered code is what a client routes on. Handles the flat v2/v1 `{ error, message }`, the nested `{ error: { code, message } }` and a bare `{ code }`. `426 client_version_unsupported`, `406 protocol_version_unsupported` (echoing `details.protocolVersions`) and `protocol_version_mismatch` get an actionable hint; a `429` prints its `Retry-After`.

### Added
- **Idempotency-Key** (`idempotency.md` §Layer 1; `runs.md` §Create RECOMMENDED): `runs create`, `runs fork`, `chat` turns, `interrupts resolve` (MUST honour), `webhooks register`, `triggers register` and `prompts create` send a fresh UUIDv4 key; `runs create|fork` and `interrupts resolve` take `--idempotency-key <k>` so re-running the same command after a timeout cannot start a second run. Out-of-grammar keys are refused locally; a response carrying `OpenWOP-Idempotent-Replay: true` is reported as "replayed from the idempotency cache".
- **v1→v2 event names** (`events.md` §Types): `src/eventTypes.ts` embeds the 36 renamed rows of `spec/v2/event-codemap.json`; `renderEvent` (chat / streaming) folds either name onto one case and now renders `run.paused`/`resume-started`/`resumed`/`dead-lettered`, `interrupt.requested`/`resolved`, `agent.tool-called`/`tool-returned`. `test/fixtures/event-codemap.json` is a byte copy of the corpus file AT a published tag (`scripts/sync-event-codemap.mjs --tag vX [--check]` reads it with `git show <tag>:…`, refusing any other ref, per `versioning.md` §4); `test/v2-wire.test.mjs` fails when the embedded table drifts from it.
- **`runs list --cursor <c> --workflow-id <id>`** (`runs.md` §List) — prints the `nextCursor` hint when the host pages.
- **`capabilities` renders the v2 representation** (`capabilities.md` §1–§3) under major 2: capability records grouped by `status` (with `until`), `minClientVersion`, `eventLogSchemaVersion`, `engineVersion`, and `extensions.<org>.<name>`. It reuses the discovery document negotiation already fetched — no second request. `OPENWOP_PROTOCOL_MAJOR=1` reads the header-less v1 document; a wrapper-less v1 document now lists its root families.
- **`doctor`: `response version` + `min client` rows** (`versioning.md` §1.4/§1.5) — reports the `OpenWOP-Version` the host answered with and FAILS when it names a different major than the one asked for (a silent downgrade); FAILS when the host's `minClientVersion` is above the version this CLI speaks (2.0 under major 2, 1.1 under major 1). Every other command prints ONE stderr warning in that case, from the discovery document negotiation already read (no extra request); refusing stays the host's call (`426`).
### Added
- **Knowledge + content coverage (batch b4).** 15 new groups — `docs`, `knowledge-sync`, `entities`, `creative-briefs`, `creative-video`, `production`, `tutorials`, `walkthroughs`, `widgets`, `ui-state`, `ui-plugin`, `canvas-collab`, `workflow-collab`, `canvas-packs`, `present` — and extended `documents` (locate, artifacts, templates catalog/assemble, canvas sources, versions, promote-html, ingest-to-kb), `notebooks` (sources incl. audio/YouTube, transformations, chat, search, ensure), `podcasts` (shows, episode/speaker profiles, publish), `media` (library assets/collections, AI edit/upscale, local-file upload/put/fetch) and `sharing` (public card/frame-view). Every host route in the batch is covered; rich bodies take `--body`/`--body-file`.

### Changed
- `podcasts list` now requires `--org` (the host's `GET /podcasts/episodes` rejects a request without `orgId`); `notebooks create`/`podcasts create` now print the id from `body.notebook.id`/`body.episode.id`, where the host returns it.
- `documents render` sends `--format` (previously always an empty body, which the host treats as pdf).
- **Commerce & sales command groups** (batch b5, ≈240 host routes): `commerce` (catalog, orders, cart, quotes, subscriptions, coupons, affiliates, reports, UCP seller + buyer, `public` storefront), `commerce-connect` (Stripe Connect seller status/onboarding links, listings, orders, payouts, approvals, admin), `promotions`, `recommendations` (+ public resolve), `dealers` (+ public partner portal), `commissions`, `territories`, `sales-maps`. `crm` gains fields, segments, suppressions, duplicates, export, merge events, gmail-sync, contact actions, and the org surface (companies, deals, pipelines, tasks, activities, import/export, booking links, sign requests, public book/sign). `crm create`/`update` accept the host's full contact field set; `crm triage` takes `--workflow-id`.
- `src/cli/resourceCommands.ts` — a declarative command table (method + route template + typed query/body flags + `--body`/`--body-file` + `--yes` guard + read-modify-write) that these groups share; help text is generated from it and names the exact path each command hits.
### Added
- **Marketing command groups (b6):** `brand-kits`, `campaign-brief`, `campaign-connectors`, `campaign-intel`, `campaign-journeys`, `cdp`, `destination-sync`, `discovery`, `funnels`, `webinars`, and `public` (the anonymous published surface: pages, blog, feeds, sitemap/robots/llms.txt; the docs list stays on `docs public`, prerenders, podcasts + audio, pricing). Covers 137 of the 138 marketing host routes (`public-analytics collect` was already covered by `analytics collect`) plus 3 routes the gap scan missed (`destination-sync` list/create, `public/:orgId/podcasts`).
- `public` subcommand families on `email` (open/click/unsubscribe/preferences/event), `forms` (get/submit) and `chat-widget` (config/message/embed), plus `funnels public`, `discovery public` and `campaign-connectors public`. Public commands never send the bearer.
- `src/cli/marketingShared.ts` — table-driven subcommand dispatch (`--body`/`--body-file`, required-flag and `--yes` gates) and `requestRaw` for non-JSON responses (feeds, HTML, JS, audio, a redirect reported without following it), routed through the same protocol rewrite as `requestJson`.
- `brand` help now points to `brand-kits` (marketing brand kits) and vice versa.

### Fixed
- **Host-extension paths renamed `/v1/host/sample/*` → `/v1/host/openwop-app/*`.** The reference host renamed that namespace in openwop-app PR #260 (2026-06-14); 66 of the CLI's 68 host-extension paths still used the old name and every one 404'd against `https://app.openwop.dev/api` (e.g. `/v1/host/sample/orgs` 404 vs `/v1/host/openwop-app/orgs` 200). The unit tests passed because they mocked fetch and asserted the old literal. Source, tests, README, FEATURES, ARCHITECTURE, ROADMAP and CLAUDE.md updated.
- `kanban watch` opened its SSE stream with a hand-built URL that bypassed `resolveRequest`; it now goes through the same negotiation as every other request.

### Changed
- **Host-proprietary roots under major 2** (`spec/v2/core/versioning.md` §5). When the negotiated major is 2 and discovery advertises an unversioned mount for an org under `extensions.*` (`{ root: "/host/<org>/", twin: "/v1/host/<org>/" }` — the reference host's `openwop-app.host`), a `/v1/host/<org>/…` request is sent to `/host/<org>/…` with **no** `OpenWOP-Version` header (such a path has no major and is outside §1.4). With no advertised root the `/v1` twin is sent unchanged; under major 1 or an `OPENWOP_PROTOCOL_MAJOR` pin nothing is rewritten.
- The single discovery read now carries `OpenWOP-Version: 2`, because only a host's v2 representation carries the §5 `extensions` mount (the header-less default is `preferredVersion`, the v1 document). Still one read per process; a host that does not serve major 2 answers `406` with `details.protocolVersions` (§1.3), which negotiation reads the same way.
- `V2_PATH_TEMPLATES` refreshed from the corpus `spec/v2/path-manifest.json` (corpus `v2.42.6-15-g61b66240`, 45 paths, 43 embedded — adds `/webhooks/{webhookId}/dead-letters` and `/webhooks/{webhookId}/rotate-secret`). New `scripts/sync-path-manifest.mjs <corpus>` (stdlib only) regenerates the list and the checked-in `test/fixtures/v2-path-manifest-paths.json`; `test/path-manifest.test.mjs` fails on drift.

## [1.0.1] — 2026-09-10

### Fixed
- `openwop --version` printed `0.18.2` from the 1.0.0 tarball: `src/constants.ts` hand-kept the string and nothing compared it to `package.json`. `VERSION` now comes from `package.json` at build time, and `test/version.test.mjs` fails the suite if the two ever differ.

## [1.0.0] — 2026-09-10 — v2-native

The CLI speaks the current protocol major. This reverses the 0.18.x "frozen
v1-only" decision recorded below; the frozen line lives on branch
`cli-v1-frozen`.

### Added
- `src/protocol.ts` — one negotiation per process (`spec/v2/core/versioning.md` §1.5): read `/.well-known/openwop` header-less, select the highest major the CLI implements that the host advertises (2, else 1), memoize on `ctx.protocolMajor`. `OPENWOP_PROTOCOL_MAJOR=1|2` pins it without a probe.
- Under major 2 every request for an operation named in `spec/v2/path-manifest.json` (41 templates at corpus `v2.0.8`, embedded) is sent to the **unversioned path with `OpenWOP-Version: 2.0`** — REST (`requestJson`) and the SSE stream alike. Commands keep their `/v1/<op>` literals; the rewrite happens at the request boundary.
- Host-proprietary routes the manifest does not name (`/v1/host/sample/*` on the demo backend) are sent exactly as written under either major — they have no v2 home yet (`versioning.md` §5).
- `openwop doctor` `protocol` row now reports `protocolVersions`, `preferredVersion`, and the major this process selected; it fails only when the host advertises neither major the CLI implements (it no longer fails v2-only hosts).

### Fixed
- The SSE stream URL is joined relative to the base URL like every other request, so a base with a path prefix survives (it previously reset the base path to `/`).

### Changed
- README §"Protocol version support" rewritten for the negotiation above.

## [0.18.2] — frozen v1-only (superseded by 1.0.0)

### Added
- `openwop doctor` — a `protocol` row: reads `/.well-known/openwop` `protocolVersions` and fails with "host is v2-only — this CLI is v1-only" when no `1.x` entry is advertised (silent when the host does not advertise the list).

### Changed
- README: recorded the steward's v2-era decision — the CLI is **frozen v1-only** (speaks the v1 wire directly, no SDK coupling), EOL = v1 end-of-support; a v2 CLI is a separate proposal. Demo-app pointer updated to `openwop/openwop-app`.

## [0.18.0] — 2026-06-30 — Second-tier groups (round 3): notebooks, podcasts, priority-matrix

### Added
- **`notebooks`** — NotebookLM-style notebooks: `list/get/create --org --title/delete` + `notes`.
- **`podcasts`** — podcast episodes: `list/get/create --title/delete/retry`.
- **`priority-matrix`** — prioritization boards: `lists/get/create --org --name/delete` + `ideas <listId>`.

This completes the full-featured CLI program (from v0.3.0): the craft foundation, every partial-group completion, all flagship product groups, and the core + second-tier groups.

## [0.17.0] — 2026-06-30 — Second-tier groups (round 2): strategy, advisors, campaigns-orchestration

### Added
- **`strategy`** — strategy documents: `list/get/create --org --title/update/delete` + `context`/`health`.
- **`advisors`** — advisory boards: `list/get/by-handle/create --org --name/delete`.
- **`campaigns-orchestration`** — orchestrated campaigns: `list/get/create/update/delete` + `finalize` (--yes).

## [0.16.0] — 2026-06-30 — Second-tier groups (round 1): evals, twin

### Added
- **`evals` command group** — model evals (org-scoped): `leaderboard`, `rating`, `match --model-a --model-b --winner` (records an arena head-to-head).
- **`twin` command group** — agent digital-twin config + grants: `get`/`set --scopes`/`clear <agentId>` + `grants`/`grant --agent --scopes`/`revoke <agentId>`.

## [0.15.0] — 2026-06-30 — Core groups (round 2): agent-allowlists, agent-packs, agent-ops

### Added
- **`agent-allowlists`** — super-admin per-agent tool-allowlist overrides (ADR 0104): `list`, `get`, `set --allowlist-json`, `clear` (--yes). Fails closed with exit 4 without super-admin.
- **`agent-packs`** — the agent (persona) pack registry: `list`, `install --name core.openwop.agents.* [--version]`. Distinct from the node-pack `packs` registry.
- **`agent-ops`** — demo/operations helpers: example-data `seed [--heal]`/`status`/`run [--step --dry-run]`/`clear` (--yes) + `roster-check`/`roster-activity`/`fleet-activity`.

## [0.14.0] — 2026-06-30 — Core groups (round 1): reviews, workspaces (tenancy), agent-profile

### Added
- **`reviews` command group** — the unified review inbox (ADR 0068 / RFC 0070): `list [--status]`, `get` (exit 0 resolved / 3 pending / 1 rejected), `action <reviewId> <action> [--note]`.
- **`workspaces` command group** — B2B workspace-as-tenant (ADR 0015): `list`, `create --name`, `switch <id>`. Distinct from the existing `workspace` (singular) file store.
- **`agent-profile` command group** — rich agent profile + connector readiness (ADR 0031): `get`, `set --profile-json`, `readiness`.

## [0.13.0] — 2026-06-30 — Flagship product groups (round 6): documents, projects

### Added
- **`documents` command group** — document generation + templates (org-scoped): `list/get/create/update/delete`, `versions`, `render`, and `documents templates {list,get,create,delete}`.
- **`projects` command group** — project workspaces: `list/get/create --org --name/update/delete` + `projects members {list,add --ref,remove}`.

This completes the flagship product groups (crm, csm, comments, sharing, forms, email, chat-widget, marketplace, kb, cms, documents, projects).

## [0.12.0] — 2026-06-30 — Flagship product groups (round 5): kb, cms

### Added
- **`kb` command group** — knowledge base (org-scoped): `kb collections {list,get,create,delete}`, `kb docs {list,get,add,delete} <collectionId>`, `kb search <collectionId> --query [--top-k]`, `kb rag <collectionId> --query [--top-k]`.
- **`cms` command group** — CMS pages + authoring lifecycle (org-scoped, ADR 0027): `cms pages {list,get,by-slug,create,update,delete,versions}` + lifecycle verbs `cms {submit,approve,reject,publish,unpublish,archive} <pageId>`.

## [0.11.0] — 2026-06-30 — Flagship product groups (round 4): chat-widget, marketplace

### Added
- **`chat-widget` command group** — embeddable chat widgets (org-scoped): `list`, `get`, `create`, `update`, `delete` (--yes), `rotate-token`.
- **`marketplace` command group** — the pack marketplace: `listings`, `install --pack --version`, and org-scoped `reviews`/`review --rating`/`unreview`. Distinct from the signed node-pack `packs` registry.

## [0.10.0] — 2026-06-30 — Flagship product groups (round 3): forms, email

### Added
- **`forms` command group** — form builder + intake (org-scoped): `list`, `get`, `create --title [--fields-json]`, `update`, `status --status <draft|published|closed>`, `delete` (--yes), `submissions`.
- **`email` command group** — outbound email (org-scoped), two sub-resources: `email templates {list,get,create,update,delete}` (name/subject/body) and `email campaigns {list,get,create,delete,send,sends}`. `campaigns send` requires `--yes` (it dispatches real email).

## [0.9.0] — 2026-06-30 — Flagship product groups (round 2): comments, sharing

### Added
- **`comments` command group** — threaded collaboration comments on a `(resourceType, resourceId)` target (org-scoped, ADR 0021): `list --org --resource-type --resource-id`, `create [--parent]`, `update`, `delete` (--yes). Every command needs `--org`.
- **`sharing` command group** — shareable resource links (ADR 0013): `list`/`create`/`revoke` (org-scoped, --org) + `resolve <token>` (reads a PUBLIC `/shared/<token>` link without auth).

## [0.8.0] — 2026-06-30 — Flagship product groups (round 1): crm, csm

### Added
- **`crm` command group** — CRM contacts (host-extension /v1/host/sample/crm/contacts): `list [--stage]`, `get`, `create --name [--email --company --stage]`, `update`, `delete` (--yes), `triage` (runs the host triage workflow over a contact). Feature-gated — a tenant without CRM enabled fails closed legibly.
- **`csm` command group** — Customer-Success accounts (…/csm/accounts): `list`, `get`, `create --name [--health-score]`, `update`, `delete` (--yes).

## [0.7.0] — 2026-06-30 — Partial-group completions, round 2

### Added
- **`kanban`**: **`card-assign`** (POST …/cards/{id}/assign), **`card-claim`** (POST …/cards/{id}/claim, ADR 0049 D4), **`boards-personal`** (GET …/kanban/boards/personal), **`assigned`** (GET …/kanban/assigned — cards assigned to you).
- **`workflows`**: **`chains`** (GET …/workflow-chains), **`from-chain`** (POST …/workflows/from-chain — expand a chain into a registered workflow), **`chain-pack-install`** (POST …/workflow-chain-packs/install) — ADR 0163 / RFC 0013.
- **`triggers`**: **`update`** (PATCH /v1/trigger-subscriptions/{id} — state transition), **`ingest`** (POST …/{id}/ingest — simulate an inbound external event, RFC 0099 §F).

## [0.6.0] — 2026-06-30 — Partial-group completions (round out existing groups)

### Added
- **`runs`**: **`fork`** (POST /v1/runs/{id}:fork — replay/branch from a sequence), **`diff`** (GET /v1/runs/{id}:diff?against — structured RFC 0054 diff), **`delete`** (DELETE /v1/runs/{id}, `--yes`-guarded), **`bulk-cancel`** (POST /v1/runs:bulk-cancel over many run ids).
- **`prompts`**: **`create`** (POST /v1/prompts), **`update`** (PUT /v1/prompts/{id}), **`delete`** (DELETE, `--yes`) — the library was read+render only.
- **`byok ai-default`** get/set/clear (GET/PUT/DELETE /v1/host/sample/byok/ai-default) — the headless AI-default credential binding (ADR 0110).
- **`governance media-budget`** get/set (GET/PUT …/governance/media-budget) — the media-generation budget (TTS chars / STT bytes, ADR 0106).
- **`catalog tools`** (GET /v1/tools [+ /{toolId}]) — the portable tool catalog (RFC 0078 §B), distinct from the node catalog + installed packs.

## [0.5.0] — 2026-06-30 — Craft foundation (config defaults, profiles, completion, upgrade)

### Added
- **The CLI now reads its saved config for defaults.** After `onboard`, everyday commands use the saved host (and bearer) with no flag — resolution is `--base-url` > `OPENWOP_BASE_URL` > saved `~/.openwop/config.json` > the built-in default (previously the saved config was written but never read).
- **`--profile <name>` global flag (+ `OPENWOP_PROFILE`).** Selects `~/.openwop-<name>/config.json`, so prod/staging/local hosts live side by side; usable on every command (was previously only honored by `onboard`).
- **`openwop completion <bash|zsh|fish>`** — emit a shell-completion script for the top-level commands, generated from the dispatcher's command+alias table (never drifts).
- **`openwop upgrade`** — check npm for a newer `@openwop/cli` and print how to update (`--json` for machine output; report-only, never auto-installs).
- **A normative Exit-codes table in `openwop --help`** — `0` success · `1` runtime/host error · `2` usage/4xx · `3` attention-needed (escalated/pending/open) · `4` auth/permission denied — so scripts can branch consistently.

## [0.4.0] — 2026-06-30 — White-label app brand

### Added
- **`brand` command group (ADR 0170 / 0171 — runtime white-label app brand).** Drives the demo host's app-brand surface: `brand public` renders the applied identity every visitor sees (anonymous `GET /v1/host/openwop-app/public-brand`); `brand get` + `brand set` read/edit the reserved app brand (super-admin `GET/PUT /v1/host/openwop-app/app-brand`). `set` is **read-modify-write** — it fetches the current brand, layers the flags, and PUTs the merged result, so setting `--accent` won't wipe the logo. The `--accent`/`--neutral`/`--contrast`/`--radius`/`--default-mode` flags feed the ADR 0171 theme generator (a full, accessible light+dark theme derived from the seed — the accent kept exact, text shades solved for WCAG-AA); `--identity-json` replaces the whole identity facet (the editor's advanced JSON tier). Enum flags are validated client-side (exit 2, no wasted request); the super-admin gate on `get`/`set` fails closed with an actionable hint (exit 4) rather than a bare `403`. `--json` on every read.

## [0.3.0] — 2026-06-14 — Agent-platform groups + trigger bridge + A2A tasks

### Added
- **`triggers` command group (RFC 0099 — external-event trigger ingestion).** Drives the host's **normative** trigger-subscription surface: `triggers register --source <webhook|email|form> --workflow <id> [--dedup] [--verification <mode>]` → `POST /v1/trigger-subscriptions` (`TriggerSubscriptionRegistration`: required `source`+`workflowId`), `triggers list [--state --source]` + `triggers get <id>` → `GET /v1/trigger-subscriptions[/{id}]`. A subscription binds an external source to a workflow the caller can start; the host verifies + dedups + runs the durable delivery state machine. `register` renders the created `TriggerSubscription` + its source-specific `binding` (ingest URL/address + `secretFingerprint`); a webhook **binding secret is surfaced once with a one-time warning and never persisted** (RFC 0099 §F.2 / SR-1), re-reads show only the fingerprint. Capability-gated on `capabilities.triggerBridge` (register additionally honesty-gates on `triggerBridge.ingestion.externalSources`); fails closed legibly. `--json` on reads; `get` exits `0` active / `3` paused / `1` failed\|dead-lettered\|error.
- **`a2a` command group (RFC 0100 — async/durable A2A tasks).** `a2a status` renders the advertised `capabilities.a2a` block (supported/streaming/pushNotifications/durableTasks); `a2a task <taskId>` reads the durable `A2ATaskState` via the host seam `GET /v1/host/sample/a2a/tasks/{taskId}` (taskId === backing runId). The record is content-free by design (state / `interruptKind` / push config — never run inputs/outputs/credentials); the CLI renders the host's resolved state and never derives one locally. Capability-gated on `capabilities.a2a` (the durable read needs `durableTasks: true`); fails closed legibly. `--json` on reads; `task` exits `0` completed / `3` submitted\|working\|input-required\|auth-required / `1` failed\|canceled\|rejected\|error.
- **`export` / `import` commands (RFC 0098 — agent-platform portability).** Move reusable estate (agents, packs, schedules, rosters, templates) between hosts as a portable bundle (sample host-extension under `/v1/host/sample/{export,import}`, promotable to normative `/v1/{export,import}` at graduation). `export [--kinds <k>]… [--out <file>] [--json]` produces a refs-only `ExportBundle` (`GET /v1/host/sample/export[?kinds=]`); `import <bundle-file> [--dry-run] [--json]` previews a no-write `ImportPlan` (`?dryRun=true`) or applies an `ImportResult` (`POST /v1/host/sample/import`). **Secrets are refs, never values:** the bundle carries only `secretsToRebind` references; the host rejects (422) a bundle smuggling a literal credential *before* applying, and the CLI runs every response through a secret redactor before printing or writing to disk (defense-in-depth). `--dry-run` is the safe default workflow — it shows creates/updates/skips/conflicts and makes zero writes; apply is idempotent and re-owns every entity to the caller host-side. Capability-gated on top-level `portability` (advertised in `/.well-known/openwop`); fails closed when absent. Subsumes the old SPA-only `migrate-tenant` bootstrap. `--json` on reads; import exits `0` applied/clean-plan / `2` plan-has-conflicts / `1` error (literal-credential or `dependsOn` cycle 422, or no import scope 403).
- **`goals` command group (RFC 0097 — standing goals).** Drives the host's standing-goals surface (sample host-extension under `/v1/host/sample/goals`, promotable to the normative `/v1/goals` at graduation): `goals list [--state]`, `get <id>`, `create --objective <text> [--judge host|verifier] [--continuation <mode>] [--max-iterations --max-cost --timeout-ms]`, `pause <id>`, `resume <id>`, `abandon <id> --yes`. The create body maps to the Goal entity shape (`completion.check` / `continuation.mode` / `bounds.{maxLoopIterations,runTimeoutMs,maxCostUsd}`). A goal is an objective the host pursues across runs until a **judge** (RFC 0090) verdicts it satisfied or a **bound** (RFC 0058) stops it. **Completion is the judge's verdict** — there is deliberately no `complete`/`satisfy` verb and the CLI never sets `state: satisfied` (the host rejects a client-supplied satisfied; we never offer it). On `create`, a bounds-less goal is rejected `422` when the host advertises `requiresBounds` — surfaced legibly so the operator adds `--max-iterations`/`--max-cost`/`--timeout-ms`. Capability-gated on `agents.goals`; fails closed legibly (exit 1) when absent. Boundary: a goal is **not** an RFC 0068 commitment — it *uses* a commitment/schedule/heartbeat as a continuation arm and adds a judge loop + termination guarantee. `--json` on every read; exit `0` satisfied / `3` escalated or still open / `1` bound-exceeded/abandoned or error.
- **`proposals` command group (RFC 0096 — reviewable learning).** Drives the host's reviewable-learning proposal lifecycle (sample host-extension under `/v1/host/sample/proposals`, promotable to the normative `/v1/proposals` at graduation): `proposals list [--state --kind]`, `get <id>`, `revise <id> [--artifact-json --note]` (PATCH the stored draft — **never activates**), `apply <id>` (asks the host to materialize the byte image last persisted on the proposal — no re-synthesis — and route activation through its advertised `agents.proposals.activation` mode, e.g. an RFC 0051 approval-gate), `reject <id> [--note]`, `archive <id> --yes` (soft-delete). A learned change lands **inert** and does nothing until a human applies it; the CLI renders the host's resolved view and relays the verb — it never activates locally. Capability-gated on `agents.proposals` (advertised in `/.well-known/openwop`); fails closed legibly (exit 1) when absent. Boundary: distinct from `approvals` (the human run-action queue) — proposals are the stored artifact *drafts* a human reviews before they become live behavior. `--json` on every read; exit `0` applied / `3` pending (in review) / `1` rejected/archived or error.
- **`analytics` command group (alias `usage`).** Org-scoped usage analytics (ADR 0018 host extension): `analytics summary <orgId>` and `analytics events <orgId>` render the host-aggregated rollup / recent events from `GET /v1/host/sample/analytics/orgs/:orgId/{summary,events}` (authed, RBAC `workspace:read`), and `analytics collect <orgId> --session <key> [--type --path --name --prop k=v]` posts to the public consent-gated beacon `POST /v1/host/sample/public-analytics/:orgId/collect` (sent **without** auth; a 202 honestly reports "consent not granted"). `--json` on reads. The host aggregates server-side — the CLI only renders what it returns, never computing a rollup locally — and fails closed legibly (exit 2) when analytics isn't served (uniform 404). This is **usage/cost/observability**, deliberately distinct from `governance audit` (the policy-decision log), so the alias is `usage`, **not** `audit`.
- **`toggles` command group.** Renders the caller's resolved feature-toggle assignments (non-normative host extension under `/v1/host/sample/feature-toggles/assignments`): `toggles list` and `toggles get <id>` show the host-resolved `status` (`on | off | beta`), `enabled`, assigned `variant`, and variant `bindings` — `--json` for the raw view. Capability-honest by construction: the **host** is the sole authority for toggle/variant resolution (it runs server-side from the principal); the CLI only displays what the host returns and never computes, asserts, or overrides a toggle decision locally, nor authors config (the superadmin config surface is intentionally not exposed). Fails closed legibly (exit 2) when the host doesn't serve the surface.
- **`auth` command group** (alias `sso`, RFC 0050) — drives the host's enterprise SSO/SAML/SCIM identity surface. `auth status` reports which auth profiles the host advertises (`/.well-known/openwop` → `capabilities.auth.profiles`) and whether a real SAML SSO deployment is live vs. conformance-seam-only; `auth saml metadata` prints the public SP metadata XML; `auth saml login-url [--return-to]` surfaces the SP-initiated IdP redirect URL without following it; `auth saml validate --idp-url --variant` drives the SAML-assertion validation seam (exit 0 authenticated / 1 rejected); `auth scim provision --op create-user|assign-group|deactivate-user` drives the SCIM provisioning seam. **Secret boundary:** SAML certs, SCIM bearer tokens, and client secrets are host-side only and never printed — every response is run through a recursive redactor (certs/assertions/tokens/secrets → `[redacted]`) before output; the public SP metadata XML is the deliberate exception. Capability-honest: discovery is authoritative (an unadvertised profile is never probed, so a host's SPA catch-all can't false-report a surface as live), and each surface fails closed legibly when the host hasn't configured it. Boundary: `auth` is identity-provider config — NOT the user directory (`users`), RBAC (`orgs`), or BYOK creds (`byok`/`providers`). `--json` on every read.
- **`mcp` command group.** An MCP client for the host's JSON-RPC server mount (RFC 0020 — a single JSON-RPC 2.0 endpoint at `POST /v1/host/sample/mcp` speaking MCP 2025-06-18): `mcp info`/`mcp ping` (initialize/ping), `mcp tools list|call`, `mcp resources list|templates|read`, and `mcp prompts list|get`, mirroring the host router's method/shape contract exactly. The mount is host-env-gated (`OPENWOP_MCP_SERVER_ENABLED`, OFF by default) and cannot be toggled from the CLI; when it isn't exposed the endpoint 404s and the commands fail closed legibly (exit 2). JSON-RPC errors surface the host's own message (contract errors → exit 2, host errors → exit 1); a tool result with `isError` exits 1. `--json` on every read.
- **`users` command group.** Tenant identity directory + account lifecycle (host users feature, ADR 0002, under `/v1/host/sample/users`): `users list`, `get <id>`, `create --principal <id> [--email --display-name --group… --source]`, `update <id>`, `disable`/`enable <id>`, `delete <id> --yes`, and `users me [--display-name]` (self record / self-rename). Mirrors the host wire exactly, including the `source` enum (`oidc | password | saml | scim | manual`) and the raw IdP `groups[]` captured for the RBAC handoff. The group is identity directory + lifecycle only — **not** RBAC (that's `orgs`) and **not** editable persona (that's `profiles`/`users me`). Capability-honest: the host is the authority; the surface 404s when not served (→ fail closed, exit 2) and a disabled account is denied 403 (surfaced legibly). `--json` on every read.
- **`governance` command group (alias `policy`).** Drives the tenant governance surface (ADR 0028, superadmin-gated host extension): `governance policy [get]` renders the host's stored policy plus its declared defaults, `governance policy set` upserts the provider allowlist / per-action policy (`email.send`, `calendar.invite`, `calendar.reschedule`, `nudge` → `disabled | draft-only | approval-required`) / retention windows, and `governance audit` reads the tenant-scoped host audit log. The host stays the policy authority — the CLI only renders its resolved view and never evaluates a policy outcome locally; since the surface is non-normative (not in `/.well-known/openwop`) the command fails closed legibly (exit 2) when a host does not expose it. `--json` on every read.

- **`approvals` command group** (alias `approval`) — drives the host approval inbox ("agents propose, humans dispose"). `approvals list [--status]`, `get <id>`, `claim <id>` (alias `approve`), `reject <id>` (alias `deny`), all with `--json`. Mirrors `GET/POST /v1/host/sample/approvals[/{id}/claim|reject]`. Capability-honest: renders the host's resolved queue and relays the human's claim/reject — never decides locally — and fails closed when the host doesn't advertise the surface. Exit codes reflect the verdict: `0` approved · `3` pending · `1` rejected/error.
- **`consent` command group** (ADR 0020) — drives the host's tenant-scoped, region-aware consent surface. Authed/org-scoped: `consent policy <orgId>`, `consent set-policy <orgId> [--default-mode] [--regulated-region]…`, `consent records <orgId>`, `consent get <orgId> <subjectKey>`, `consent erase <orgId> <subjectKey> --yes` (GDPR erasure). Public/unauthed: `consent public get|record <orgId> <subjectKey>`. The CLI renders the host's resolved view (it never computes a consent outcome) and fails closed with a legible message on the host's uniform 404 when the `consent` toggle is off. `--json` on every read.
- **`connections` command group** (alias `conn`) — inspect host third-party connections + OAuth client config (ADR 0024). `connections list`, `get <id>`, `test <id>` (health-probe; exit `0` healthy / `1` not), `authorize <provider> [--scope]… [--write] [--return-to]` (mints a consent URL and prints it — the CLI never completes the OAuth exchange), and `connections oauth-clients list|get`, all with `--json`. Mirrors `GET /v1/host/sample/connections`, `POST .../{id}/test`, `POST .../{provider}/authorize`, `GET /v1/host/sample/connections-oauth-clients`. **Secret boundary:** client secrets/tokens are host-side and are never printed — every response is run through a recursive redactor before output. Capability-gated; fails closed when the surface isn't advertised.
- **`profiles` command group** (ADR 0005) — drives the host's self-service user-profile/persona surface. Reads: `profiles list` (tenant persona directory), `profiles get [<userId>]` / `profiles me`, `profiles activity [--limit] [--status]`. Self-writes (always keyed on the caller's own resolved identity): `profiles edit` (job title / department / bio / location / equipment / interests / availability), `profiles skills set --skill <name=proficiency>…`, `profiles portfolio add|remove`, `profiles pin|unpin <rosterId>`. Peer: `profiles endorse|unendorse <userId> <skill>`. The host is the authority and the CLI renders its resolved view; requires a durable signed-in account and fails closed legibly on 401 (not signed in) / 404 (not found). Boundary: `profiles` is the persona/skills surface, **not** the user directory (account lifecycle) and **not** RBAC (`orgs`). `--json` on every read.
- **`workforces` command group** (alias `fleet`) — durable multi-agent orchestration at fleet scale (Governed Workforce host-extension). `workforces list`, `get <id>`, `metrics <id>`, `governance <id>` (autonomy graduation + posture), `migration <id>`, `trace <id> [--q]`, `shadow <id>` (reads, `--json`), `status <id> <shadow|piloting|production>` (cutover PATCH — the host gates promotion to `production` on graduation; 409 → legible exit 1), and `eval <id>` (live shadow eval; 501 when the host's eval suite is disabled → fail closed). Mirrors `/v1/host/sample/workforces[...]`. Composes with `kanban`/`roster` but does not duplicate them — it renders the workforce's governance/metrics view, never re-modelling boards or roster entries. Capability-gated; fails closed when the surface isn't advertised.

### Changed
- **`cron` group extended (RFC 0052):** added `cron enable <jobId>` / `cron disable <jobId>` — `PATCH /v1/host/sample/scheduler/jobs/{jobId}` with `{enabled:true|false}` to toggle a schedule active/inert — and a `--roster <rosterId>` filter on `cron list` (`?rosterId=`). `cron list` now also surfaces each job's `enabled` and `rosterId`. Rides cron's existing RFC 0052 (no new RFC); reads carry `--json`.

### Fixed
- **RFC-group wire-fidelity (caught by live-smoke vs openwop-app).** Three corrections so the `proposals`/`goals`/`export`+`import` groups actually drive a real host: (1) gate on the **capability flag** (`capabilities.{agents.proposals,agents.goals,portability}`) instead of a `/.well-known/openwop` `paths` map — the discovery doc carries no paths map, so the original gate false-failed-closed even when the surface was advertised; (2) `goals create` now sends the **Goal entity shape** (`completion.check` / `continuation.mode` / `bounds.{maxLoopIterations,runTimeoutMs,maxCostUsd}`) rather than the capability-descriptor field names, and `goals` reads render the entity shape (`--deadline` → `--timeout-ms`); (3) `import` wraps the POST body as `{ bundle }` (the host reads the bundle under a top-level `bundle` key). All three verified end-to-end against the live reference host (proposals/goals/export+import incl. the requiresBounds-422, literal-credential-422, and apply-403 fail-closed legs).

### Security
- **Bumped `esbuild` `^0.24` → `^0.25`** (GHSA-67mh-4wv8-2f99 — esbuild dev-server request advisory). Build/dev dependency only; the published CLI tarball (`dist/` + `install.sh` + `README.md`) behavior is unchanged.

## [0.2.2] — 2026-06-06 — Publish-pipeline fixes (CI only)

Release-infrastructure only — the published tarball (`dist/`, `install.sh`,
`README.md`) is byte-identical to `0.2.1`. No runtime/behavior changes.

- **Fixed OIDC trusted publishing.** `actions/setup-node`'s `registry-url` writes an `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` line into `.npmrc` and injects a placeholder `NODE_AUTH_TOKEN`; npm used that invalid token instead of the OIDC token exchange (publish `PUT` 404'd). `publish.yml` now strips that line before `npm publish` so npm ≥ 11.5.1 performs the trusted-publisher exchange. (This is what unblocked the `0.2.1` publish.)
- **Hardened the npmrc rewrite.** Guard `NPM_CONFIG_USERCONFIG` before overwriting it, so a future `setup-node` change fails loudly instead of with a cryptic `> ""` ambiguous-redirect mid-release.
- **Doc fix.** Dropped a stale `openwop:check` step-10 reference in `ci.yml` (that gate step was removed when the CLI was extracted).

## [0.2.1] — 2026-06-06 — Repository extracted to `openwop/openwop-cli`

The CLI moved out of the [`openwop/openwop`](https://github.com/openwop/openwop)
monorepo into its own repository and now publishes from here. No behavior changes —
this release exists to (re)establish the publish pipeline from the new home.

- **New home.** Source promoted to repo root; `repository` / `bugs` metadata repointed at `openwop/openwop-cli`. The package remains `@openwop/cli`, still published to npm with OIDC provenance (trusted publisher repointed from `openwop/openwop` to this repo). Tag pattern simplifies from `cli/vX.Y.Z` to `vX.Y.Z`.
- **No source changes** beyond the `0.2.0 → 0.2.1` version bump (kept in lockstep across `package.json` and `src/constants.ts`).

## [0.2.0] — 2026-06 — Agent-platform surfaces

- The CLI drives every demo-app protocol surface it previously lacked: `roster` (RFC 0086), `org-chart` (RFC 0087), `kanban` boards + cards (with an SSE `watch`), `orgs` orgs/teams/groups/roles/members RBAC + effective-access (RFC 0049), `workspace` files (RFC 0059 §C real CRUD), `byok` secret refs (values never returned), and user-defined-agent `create`/`update`/`delete` on the `agents` group. All read commands support `--json`; all destructive commands require `--yes`.
- Fixed the stale `--version` constant (reported 0.1.0 on the 0.1.x package) and the `agents run` flag-parsing bug where `--task-json`/`--no-validate` never took effect (option keys are camelCased).

## [0.1.0] — 2026-05-28 — OpenWOP CLI launch

- First public release to npm: `npm install -g @openwop/cli` — a control-plane CLI for any OpenWOP-compatible host (auth onboarding, capabilities, runs + SSE streaming, prompts · memory · agents · interrupts, channel-relay daemons). Operator-side, independently versioned; published through the OIDC publish pipeline with provenance. Strict TypeScript (`strict` + `noImplicitAny`); `node --test` suite gates every release.
