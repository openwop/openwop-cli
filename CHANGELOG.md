# Changelog

All notable changes to `@openwop/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the CLI is independently
versioned on its own SemVer line.

## [Unreleased]

### Fixed
- **`developer-keys` help named a scope the reference host does not have.** The example used `--scope runs:write`; openwop-app's scopes are `runs:create`, `runs:read`, `runs:cancel` and so on, and a key that declares scopes is limited to exactly those, so a `runs:write` key was refused every run operation. The example now declares `runs:create` and `runs:read`, and the help says that a declared key is narrowed and that openwop-app refuses `create` (403) when the CLI is itself signed in with a developer key (openwop-app ADR 0794).
- **Capability checks read both discovery representations.** A dual-stack host serves two documents at `/.well-known/openwop`, selected by `OpenWOP-Version`, and they need not carry the same records. The v2 reference host (openwop-examples `examples/hosts/v2-reference`) keeps `a2a` only at its closed v2 root. app.openwop.dev keeps `a2a`, `portability` and `triggerBridge` only in its v1 document. `a2a`, `triggers`, `goals`, `proposals` and `portability` read only the header-less document, so `openwop a2a status` against the reference host reported "capabilities.a2a absent" while `openwop capabilities` listed `a2a`. They now look there first, then in the negotiated document (`advertisedRecord`). A record found in either counts as advertised, and nothing that passed before is refused now.
- `a2a status` prints `a2a.supported: yes` for a v2 record, which has no `supported` flag: in v2, presence is the claim (capabilities.md §2).
- **`interrupts list` fails closed on a host without the openwop-app extension.** It used to exit 2 with a bare `HTTP 404 not_found: no operation at …`. It now names the extension path it reads, says the host does not serve it, points to `interrupt.requested` in the run's events and `interrupts respond <runId> <nodeId>`, and exits 1. A 404 for a missing run on a host that does serve the route is unchanged.

## [1.3.0] — 2026-09-28 — the pack commands read the registry's v2 tree

`openwop packs` resolves every registry path through the registry's discovery document and prefers the v2 tree, verifies v2 signatures, and resolves versions the way RFC 0222 requires. `openapi` and `workspace` now use their v2 homes on a host that speaks protocol major 2. **Read § Changed before upgrading scripts.** An exact pin of a yanked version now installs (with a warning) instead of being refused, and `publish` / `yank` now target the v2 tree.

### Added
- **`packs` resolves paths through `/.well-known/openwop-registry.json` `endpoints`** (spec/v2/core/packs.md §"The registry tree": a client MUST resolve every registry path through it). It prefers `endpoints.v2`. The v1 templates are used only when the registry names no v2 tree, or publishes no discovery document, or you pass the new `--tree v1`. `--tree v2` against a registry with no v2 tree fails closed (exit 1). `search --json` and `install --json` report the `tree`, and `info` prints it.
- **v2 signature verification** (packs.md §Signing):
  - `signing` must be exactly `{ keyId, scheme: "ed25519-canonical-json" }`. A v1 field (`method`, `publicKeyRef`, `signatureRef`) is refused.
  - The detached 64-byte `.sig` must verify over the in-tarball `pack.json`, whose bytes must be RFC 8785 canonical and must name the requested `name@version`.
  - The key is the registry's `signingKeys[]` entry for `keyId`, fetched from its `publicKeyUrl`, and its `permittedNamespaces` must cover the pack name.
  - A key that is no longer `active` still verifies what it signed.
  - Every failure reports `pack_signature_invalid` and exits 1. Measured against packs.openwop.dev: all 198 served v2 versions install and verify.
- **Version ranges for `packs install`**: `^`, `~`, `x`-ranges, comparator sets (`>=1.0.0 <2.0.0`) and `||`. A range resolves to the highest *unyanked* match. If only a yanked version matches, the error says so and suggests pinning it.
- A missing pack reads `No pack named <name> on <registry> (<tree> tree)` instead of `HTTP 404`.

### Changed
- **Behaviour change — yank semantics follow RFC 0222 §B / packs.md §"Version manifests".** `latest` (no version) never resolves a yanked version, even when the index names it `latest`; it falls back to the highest unyanked version. An **exact pin may install a yanked version**, with a stderr warning. 1.2.x refused every yanked install. A deprecated version (`versionDeprecated`) installs with a warning.
- **`packs publish` writes the v2 signing block** `{ keyId, scheme }` by default. Its next-step hint names `registry/v2/` and `build-index.mjs --tree v2`. `--tree v1` keeps the legacy `{ method: "manual", publicKeyRef, signatureRef }` block.
- **`packs yank` edits `registry/v2/…`** by default. `--tree v1` edits the frozen v1 tree.
- **`openapi` on a major-2 host** requests `GET /openapi.json` with `OpenWOP-Version: 2.0` (the manifest's getOpenApiSpec). A v2 host answers `/v1/openapi.json` only at major 1.
- **`workspace` on a major-2 host that advertises `conformance.seamsProfile: "openwop-conformance-seams-v2"`** uses `/conformance/seams/workspace/files[/{path}]` with `OpenWOP-Version: 2.0`. v2 names no canonical workspace operation; the seams profile is its only v2 home. Without that advertisement it keeps `/v1/host/workspace/files`.
- Help text now says which commands stay on v1 and why:
  - `catalog packs list|search|get|export`: v2 names no installed-packs operation.
  - `ui-plugin rpc --conformance-alias`: the v2 seams profile defines no ui-plugin operation.

### Fixed
- **Piped output is no longer cut off at 64 KB.** The entry point called `process.exit()` before a piped stdout drained, so `packs search --json | jq` (131 KB against packs.openwop.dev) received truncated JSON. It now exits after stdout drains.

## [1.2.3] — 2026-09-27

### Fixed
- **A local base URL never follows an advertised stream origin off the machine.** With `--base-url` on a loopback host, a discovery `streamBase` is now accepted only if it is also loopback. Before, a local host (or a local proxy in front of a real one) advertising an `https:` origin sent the event stream — and the CLI's automatic localhost development key, chosen because the base is local — to that remote origin. Found when the reference host started advertising `streamBase`; `scripts/live-sse-resume.mjs` now also pins the stream origin to its own proxy.

## [1.2.2] — 2026-09-27 — one command engine, no quirks

A blank number flag no longer silently sends 0, and the 15 spec-table groups now print, help and hint like every other group. Exit codes and `--json` output are unchanged for every command (verified across 7,274 snapshot invocations).

### Fixed
- **A blank number flag is a usage error, no longer sent as 0.** In the route-table groups a blank value such as `--limit=` or `--cost-usd=` read as `Number('')` = 0 and was sent (e.g. `roster activity <id> --limit=` requested `?limit=0`). Every group now refuses it with `--<flag> must be a number (got "")` and exit 2 before any request — the behaviour the spec-table groups already had.

### Changed
- **The 15 spec-table groups** (`capability-firewall`, `chat-widget`, `cms`, `commerce`, `commerce-connect`, `commissions`, `crm`, `dealers`, `email`, `forms`, `kb`, `promotions`, `recommendations`, `sales-maps`, `territories`) **now match the rest of the CLI** in human output (a write prints `OK — <command> (HTTP n).` before the body), per-command `--help`/usage text, input-error wording, and host-error hints (401 → "Not signed in…", 403 → "Permission denied…", 404 → "Not found — or the feature is not enabled…"). **Exit codes and `--json` output are unchanged** — verified over every recorded invocation of the command-behaviour snapshot. Scripts that parse human-mode output should use `--json`.
- The command-behaviour snapshot now covers every route-table group (501 commands, 7274 invocations, up from 289 / 4126), and `scripts/diff-command-snapshot.mjs` classifies a fixture diff against an explicit profile.

## [1.2.1] — 2026-09-27 — quality pass on 1.2.0

Findings from the post-release code / UX / data grading of the 1.1–1.2 work. No new flags.

### Changed
- **A buffering front door is detected in 10 s, and said so.** An events stream whose response headers do not arrive within 10 s (`min(--idle-timeout-ms, 10000)`) is followed by polling, with one stderr line explaining why and naming `--stream-base-url` (`--quiet` suppresses it). Before, the command sat silent for the full 45 s idle timeout. Once headers arrive, only the idle timeout applies.
- `--stream-base-url` / `OPENWOP_STREAM_BASE_URL` / config `host.streamBaseUrl` refuse a URL carrying credentials (`user:pass@`) — it would sit in plaintext in `~/.openwop` config and shell history; the bearer already travels as `--api-key`.
- `--verbose` reconnect lines say whether the connection **dropped** or **stalled** (with the silence); giving up says how to continue (`--since <last sequence printed>` or `--no-stream`).

### Fixed
- **One secret redactor.** `connections`, `export`/`import` and `auth` each carried a private copy of the redactor, and they had drifted; one traversal (`src/redact.ts`) now serves all three, each surface keeping its own policy (no output change). The CLI has no `as any` casts left.
- `scripts/live-sse-resume.mjs` finds its upstream from the host's advertised `streamBase` before falling back to the reference origin.

## [1.2.0] — 2026-09-27 — streams that work through a buffering front door

Every event stream the CLI opens (`runs watch`, `chat`, `notifications stream`, `kanban watch`, `present`) delivered nothing through the reference host's public front door, which buffers streams entirely. 1.2.0 reads streams from a stream origin, resumes stalled streams, and lets anonymous reads of the protocol agent surfaces succeed on a v2 host. **Read § Changed before upgrading scripts** — two defaults moved.

### Added
- **Stream origin.** Event streams are read from `--stream-base-url` > `OPENWOP_STREAM_BASE_URL` > config `host.streamBaseUrl` > a host-advertised `extensions.*.streamBase` > `--base-url`; everything else stays on `--base-url`. Measured: the reference host's public front door (`https://app.openwop.dev/api`, a CDN rewrite) delivered 0 bytes of an event stream in 25 s, so `runs watch`, `chat`, `notifications stream`, `kanban watch` and `present` never showed a live event through it. An advertised origin receives the bearer, so it is accepted only if `https:` without credentials/query/fragment and read from an `https:` host (loopback `http:` only for a loopback base). All five stream call sites now go through one seam (`resolveStreamRequest`); `present` also gains the bearer it omitted.
- **Idle watchdog** on run streams: no bytes (keep-alives count) for `--idle-timeout-ms` (default 45000; 0 disables) → abort + resume with `Last-Event-ID`. A half-open connection used to block forever.
- `scripts/live-sse-resume.mjs` — a live check against a real run: breaks the first events stream (`--mode drop` destroys the socket, `--mode stall` holds it silent) and asserts the reconnect carried `Last-Event-ID`, no event printed twice, terminal event reached. Passed both modes against the reference host 2026-09-27.

### Fixed
- **Anonymous normative reads no longer dead-end on a v2 host.** `agents list|info`, `roster list` and `org-chart get|dept` read the normative `/v1/agents*` first; a v2 host MUST refuse a request that presents no credential (`401` + `WWW-Authenticate: Bearer` with no `error=`, RFC 0200 §B.1 / `identity.md` §2.5), so anonymous use of these commands exited 4. They now fall back to the host's anonymous view (the host-extension alias) on exactly that challenge **and** only when the request sent no credential — never on `invalid_token`, a refused `--api-key` or caller credential, a bare 401 or a 403 (no silent identity switch). The fallback is announced on stderr every time, naming the path actually sent; if the host has no such alias, the original 401 is reported.

### Changed
- **Streams may leave `--base-url`.** When a host advertises `streamBase` (the reference host does, openwop-app ADR 0761), event streams — and the bearer they carry — go to that origin instead of `--base-url`. If you point `--base-url` at an egress or audit proxy, keep streams there with `--stream-base-url <the same URL>` (or `OPENWOP_STREAM_BASE_URL`): a user setting always wins. `openwop doctor` now has a **stream origin** row naming the origin and why, and `--verbose` says so whenever a stream opens off `--base-url`.
- **Anonymous `agents list|info`, `roster list`, `org-chart get|dept` exit 0 on a v2 host** (they exited 4): the host's anonymous view is shown, announced on stderr. A script that treated exit 4 as "not signed in" should pass `--api-key` or check stderr. Details under § Fixed.
- **One command engine (internal refactor; no behaviour change for any existing command).** The spec-table groups (`commerce`, `commerce-connect`, `promotions`, `recommendations`, `dealers`, `commissions`, `territories`, `sales-maps`, `capability-firewall`, the `crm` extensions and the `cms`/`email`/`forms`/`kb`/`chat-widget` extension legs) now execute on `routeKit`'s single parse → coerce → read-modify-write → confirm → request → render pipeline; `resourceCommands.ts` keeps only its concise `key:type!=flag` declaration syntax and help renderer, translated into a `RouteCmd` by an adapter that sets every behaviour explicitly. Every one of the 289 spec commands (4,126 invocations, 304 help texts) is pinned by `test/command-behaviour-snapshot.test.mjs` against a fixture generated from the pre-refactor code (`scripts/snapshot-commands.mjs` regenerates it). Three edge cases no existing command can reach now behave like the rest of the CLI: an empty `--body-file=` is a usage error (it was silently ignored); a spec field key containing a dot is a nested body path; a flag name with a digit after a dash follows `parseOptions` naming (it was silently dropped).

## [1.1.0] — 2026-09-27 — full host coverage + v2 client compliance

The CLI now drives every operator-facing route of the reference host (1,471 of 1,477 — the 6 not driven are provider webhooks, OAuth/SSO browser callbacks and the emailed-approval HTML pages, which no command line calls) and meets the v2 client obligations in `spec/v2/core/*` (corpus `v2.42.6`). It also fixes a 1.0.x regression: 66 host-extension commands 404'd against the live reference host.

### Added

#### Protocol v2 client compliance

- **Idempotency-Key** (`idempotency.md` §Layer 1; `runs.md` §Create RECOMMENDED): `runs create`, `runs fork`, `chat` turns, `interrupts resolve` (MUST honour), `webhooks register`, `triggers register` and `prompts create` send a fresh UUIDv4 key; `runs create|fork` and `interrupts resolve` take `--idempotency-key <k>` so re-running the same command after a timeout cannot start a second run. Out-of-grammar keys are refused locally; a response carrying `OpenWOP-Idempotent-Replay: true` is reported as "replayed from the idempotency cache".
- **v1→v2 event names** (`events.md` §Types): `src/eventTypes.ts` embeds the 36 renamed rows of `spec/v2/event-codemap.json`; `renderEvent` (chat / streaming) folds either name onto one case and now renders `run.paused`/`resume-started`/`resumed`/`dead-lettered`, `interrupt.requested`/`resolved`, `agent.tool-called`/`tool-returned`. `test/fixtures/event-codemap.json` is a byte copy of the corpus file AT a published tag (`scripts/sync-event-codemap.mjs --tag vX [--check]` reads it with `git show <tag>:…`, refusing any other ref, per `versioning.md` §4); `test/v2-wire.test.mjs` fails when the embedded table drifts from it.
- **`runs list --cursor <c> --workflow-id <id>`** (`runs.md` §List) — prints the `nextCursor` hint when the host pages.
- **`capabilities` renders the v2 representation** (`capabilities.md` §1–§3) under major 2: capability records grouped by `status` (with `until`), `minClientVersion`, `eventLogSchemaVersion`, `engineVersion`, and `extensions.<org>.<name>`. It reuses the discovery document negotiation already fetched — no second request. `OPENWOP_PROTOCOL_MAJOR=1` reads the header-less v1 document; a wrapper-less v1 document now lists its root families.
- **`doctor`: `response version` + `min client` rows** (`versioning.md` §1.4/§1.5) — reports the `OpenWOP-Version` the host answered with and FAILS when it names a different major than the one asked for (a silent downgrade); FAILS when the host's `minClientVersion` is above the version this CLI speaks (2.0 under major 2, 1.1 under major 1). Every other command prints ONE stderr warning in that case, from the discovery document negotiation already read (no extra request); refusing stays the host's call (`426`).
- **Automatic resume on a dropped run stream.** `streamRunEvents` (behind `chat`, `workflow-author` and the new follow mode) remembers the last SSE `id:` and reconnects with `Last-Event-ID` when the connection drops or closes before the terminal event (events.md §Resuming with `Last-Event-ID`; v1 stream-modes.md §Resumption). The delay honours the server's `retry:` field (default 1 s), doubles per attempt without progress (cap 30 s), and gives up after 5 attempts with exit 1. A close is checked against the run's status first, so a run that went terminal ends the stream instead of reconnecting. Events are deduped by `sequence` (batch frames included), so a resume never prints an event twice. A resume refused with a 4xx is reported, not retried.
- **`runs events <runId> --follow`** (alias **`runs watch <runId>`**): stream a run's events over SSE until its terminal event (poll fallback; `--no-stream` forces it), with `--since <sequence>` / `--last-event-id <id>` to start mid-log — sent as the `Last-Event-ID` header under both majors (the spec defines no `since` stream parameter; v2 requires an integer id) — and `--stream-mode <mode>` (`?streamMode=`, validated against the v2 pattern `values | (updates|messages|debug)[,…]`). `--json` prints one event per line. Exit 1 when the run fails or is cancelled.
- A host `400 unsupported_stream_mode` (or any 4xx to a requested mode/cursor) is now surfaced instead of silently falling back to the poll endpoint, which has no stream mode.

#### Protocol + run operations

- **Normative agent reads.** `agents list|info`, `roster list` and `org-chart get|dept` now call the normative `GET /v1/agents[/{agentId}]`, `/v1/agents/roster` and `/v1/agents/org-chart[/{departmentId}]` (RFC 0072 §A / 0086 / 0087 §D — `/agents/*` under v2), and fall back to the `/v1/host/openwop-app/*` alias only on 404/405/501. `--host` forces the alias (the normative roster omits host-only entries such as advisors); `--verbose` names the path that answered.
- **New groups:** `content` (RFC 0103 `/v1/content/*`: page delivery with `--locale`, pages, create, delete, section, settings), `agent-knowledge` (ADR 0038 per-agent knowledge + notes + memory-writable), `compat-endpoints` (RFC 0108; key from file/env only, never echoed), `host-events` (ADR 0208 bindings), `client-support` (ADR 0413 min-build handshake), `dispatch fanout` (RFC 0118 join witness), `openapi` (`/v1/openapi.json`).
- **Extended groups:** `runs effects|revision|pin|unpin|redrive`; `interrupts inspect <token>` (GET `/v1/interrupts/{token}`) and `interrupts respond <runId> <nodeId>` (POST `/v1/runs/{runId}/interrupts/{nodeId}`, `{ resumeValue }`, Idempotency-Key); `webhooks rotate-secret` (RFC 0201; secret from `--generate`/file/env, generated secret revealed once on stderr) and `webhooks dead-letters` (RFC 0188, v2); `catalog packs search|get|export` (host-installed packs); `workflows archive|unarchive|promote|revisions|rollback|stats|estimate|pins|pin-set|pin-delete|pins-clear|pins-from-run|debug-run|eval-sets|eval-set get|put|delete|run|online|eval-results`; `approvals sla-policy [set]` (read-modify-write), `email-pref [set]`, `delegations list|create|revoke`, and `claim|reject --acted-for --expected-hash`; `reviews list --conversation --board`, `reviews action --value-json --expected-hash`; `prompts library …` (ADR 0116 org prompt library) and `prompts render --content-trust`; `agent-profile capability-on|off`; `agents eval-run|verify-run`.
- Host-extension run routes send a tenant-bound run id in the projected `~2F` form under v2 (`hostRunSegment`), matching what `resolveRequest` does for manifest routes.

#### Identity, access and operator administration

- **Identity, RBAC and operator-administration coverage (batch b2).** 9 new groups — `vault` (super-admin secrets vault: refs only, set/rotate from a file or no-echo prompt, delete; reveal deliberately not driven), `developer-keys` (token shown once), `custom-domains`, `environments` (snapshot / preview / promote / rollback / apply; exit 3 when queued for approval), `billing` (reads + Stripe-hosted checkout/portal URLs, super-admin import/coupons/seats/invoices), `site-config`, `runtime-posture`, `maintenance`, `menu-config`. Extended `orgs` (invites, invitations accept/decline/preview, `decide` — the RFC 0049 decision seam, transfer-ownership, `effective --member/--org`, custom roles in `roles list`, members create without `--subject`), `users` (me security / factor-event / sign-out-everywhere, revoke-sessions, logout, oidc-bind), `governance` (egress-rules, byok-chat-budget, audit `--format`, audit-export, media-budget `--images/--video-jobs`), `toggles admin` (list / get / features / env-governed / read-modify-write set / reset), `byok active-config`, `admin run-retention` (+ legal holds), `auth break-glass`, `brand asset`, `analytics rollup`, `workspaces migrate-anon`.
- Super-admin, admin-token and scope-gated surfaces in these groups fail closed with ONE actionable message and exit 4 (`src/cli/adminShared.ts` `gatedRequest`), echoing the host's hint.

#### Conversations and messaging

- **`chat` extended — still ONE chat group.** Besides the `chat <workflowId>` REPL (now also `chat repl`): `chat sessions list|get|create|update|delete|branch|read|board|bind-run`, `chat messages list|send|edit|delete|react|unreact` (paged with `--limit`/`--before`), `chat participants`, `chat open` (idempotent 1:1), `chat feedback set|get|list`, `chat models`, `chat search` (GET or `--post`), `chat export` (md/json, `--output`), `chat import`, and `chat tools get|set|approve|deny` (per-conversation tool scope; `set` is read-modify-write because the host replaces the scope). Creates/sends carry an `Idempotency-Key`.
- **New groups:** `assistant` (projects, commitments, decisions, meetings, stakeholders, briefing, health, loops, and the drafted-action queue — `approve` requires the reviewed `--content-hash`), `channels` (team channels incl. live `stream`, presence, agent reply policy, AI `catchup`), `scheduled-chats` (org + channel scope), `voice` (walkie-talkie sessions + the realtime bridge; the ephemeral token is redacted unless `--reveal-token`), `ai` (modality-gated `call`, `speech`, `transcribe`, user-scope `bind-credential` reading the value from a file/env), `computer-use`, `whatsapp` (health + no-training attestation), `agent-author`, `workflow-author` (`draft --follow` streams the authoring run), `workflow-proposals` (operator auto-approval policies).
- **`a2a` extended:** `rpc <method>` (JSON-RPC 2.0 against the host's A2A server, `--a2a-version` header; a JSON-RPC error exits 1), `start`, `push-config`, `invoke`.
- **`notifications` extended:** `stream` (live, server-sent events) and `push config|list|subscribe|unsubscribe`.
- `src/cli/chatShared.ts` — `streamHostSse` consumes a host-extension event stream through the same path negotiation + frame decoder as the run stream, bounded by `--max-events` / `--timeout-ms`.

#### Knowledge and content

- **Knowledge + content coverage (batch b4).** 15 new groups — `docs`, `knowledge-sync`, `entities`, `creative-briefs`, `creative-video`, `production`, `tutorials`, `walkthroughs`, `widgets`, `ui-state`, `ui-plugin`, `canvas-collab`, `workflow-collab`, `canvas-packs`, `present` — and extended `documents` (locate, artifacts, templates catalog/assemble, canvas sources, versions, promote-html, ingest-to-kb), `notebooks` (sources incl. audio/YouTube, transformations, chat, search, ensure), `podcasts` (shows, episode/speaker profiles, publish), `media` (library assets/collections, AI edit/upscale, local-file upload/put/fetch) and `sharing` (public card/frame-view). Every host route in the batch is covered; rich bodies take `--body`/`--body-file`.

#### Commerce and sales

- **Commerce & sales command groups** (batch b5, ≈240 host routes): `commerce` (catalog, orders, cart, quotes, subscriptions, coupons, affiliates, reports, UCP seller + buyer, `public` storefront), `commerce-connect` (Stripe Connect seller status/onboarding links, listings, orders, payouts, approvals, admin), `promotions`, `recommendations` (+ public resolve), `dealers` (+ public partner portal), `commissions`, `territories`, `sales-maps`. `crm` gains fields, segments, suppressions, duplicates, export, merge events, gmail-sync, contact actions, and the org surface (companies, deals, pipelines, tasks, activities, import/export, booking links, sign requests, public book/sign). `crm create`/`update` accept the host's full contact field set; `crm triage` takes `--workflow-id`.
- `src/cli/resourceCommands.ts` — a declarative command table (method + route template + typed query/body flags + `--body`/`--body-file` + `--yes` guard + read-modify-write) that these groups share; help text is generated from it and names the exact path each command hits.

#### Marketing

- **Marketing command groups (b6):** `brand-kits`, `campaign-brief`, `campaign-connectors`, `campaign-intel`, `campaign-journeys`, `cdp`, `destination-sync`, `discovery`, `funnels`, `webinars`, and `public` (the anonymous published surface: pages, blog, feeds, sitemap/robots/llms.txt; the docs list stays on `docs public`, prerenders, podcasts + audio, pricing). Covers 137 of the 138 marketing host routes (`public-analytics collect` was already covered by `analytics collect`) plus 3 routes the gap scan missed (`destination-sync` list/create, `public/:orgId/podcasts`).
- `public` subcommand families on `email` (open/click/unsubscribe/preferences/event), `forms` (get/submit) and `chat-widget` (config/message/embed), plus `funnels public`, `discovery public` and `campaign-connectors public`. Public commands never send the bearer.
- `src/cli/marketingShared.ts` — table-driven subcommand dispatch (`--body`/`--body-file`, required-flag and `--yes` gates) and `requestRaw` for non-JSON responses (feeds, HTML, JS, audio, a redirect reported without following it), routed through the same protocol rewrite as `requestJson`.
- `brand` help now points to `brand-kits` (marketing brand kits) and vice versa.

#### Operations and work management

- **13 new groups:** `operations` (operator console: health/SLO/DLQ/outbox/webhook summaries, DLQ replay, outbox redrive, delivery retry, trigger pause, saga compensation), `service-desk` (tickets, intake config, anonymous `public send|thread`), `job-search`, `kicktodo` (readiness — a `503 degraded` prints the blockers and exits 1 — and the Challenge Author agent), `dashboard`, `bi`, `insights-suite`, `intent-ledger`, `work-graph`, `work-selection`, `tasks`, `model-router`, `dev` (`ucp-merchant call`).
- **Extended:** `strategy` (update covers every field, `delete --hard`, `context` for one strategy or by project/list/board, timeline, versions/restore, check-ins add/confirm/dismiss, decisions, import-objectives from CSV, initiatives from an idea, links, cadence, reindex-kb); `priority-matrix` (list update, ideas add/update/delete/clone/merge/promote/status/score/score-history/votes/intake/evidence/schedule, delivery schedule, sessions, scenarios + compare/select/reject, portfolio + federated, presets, peers + credential from a file, reindex-kb); `projects` (full update, visibility, members `--role`, knowledge incl. base64 file upload, memory, schedules, chat); `profiles` (pin-chat, avatar, workflows, personal knowledge + memory, `edit --preferred-name/--growth-interests/--link`); `twin recalls`; `goals arm|evaluate|record-run`; `workforces migration set`; `roster activity|check`; `agent-ops clear --step`, `provision-demo`, `summary`, filtered activity; `analytics trend`, `nav report|record`, `--days`; `marketplace feature-bundles`, `pack-enablement`, `certify`, `packs remove|restore`; `connections delete`, `inbound [set|remove]`, `providers`; `workspace op` (RFC 0059 WCT-1 conformance seam).
- `src/cli/routeKit.ts` — the route table these groups share: nested (dotted) body keys, deep read-modify-write for replace-on-write routes, optional-id path variants, `key=value` maps, text/base64/JSON file fields, a fail-closed advertisement guard, output transforms (secret redaction), and help generated from the same table.

#### Settings, policy and remaining host surfaces

- **3 new groups:** `capability-firewall` (rules — read-modify-write, decisions, host-evaluated `simulate`, super-admin `platform rules`), `heartbeat settings` (super-admin, read-modify-write), `settings prefs` (personal token cap, reasoning directive, privacy opt-outs; read-modify-write).
- **Extended:** `cms` (`schedule publish|unpublish|clear-*`, `pages review|restore`, `shared-sections` CRUD + impact list, `language-settings`, `locale-grants`, `locales publish|unpublish`, `translate-section`, `experiments` CRUD/start/stop/promote/results, `seo [set]` over the publishing route); `email` (`settings`, `provider-status`, `webhooks` list/add/remove — secret from a file, `campaigns engagement`); `kb collections retrieval|ingest-media|reindex drain|cancel`; `forms templates|from-template`; `chat-widget tool-catalog`; `consent purposes [add|remove|strict]`, `readmit`; `approvals teams-pref [set|clear]`; `profiles memory-extraction [grant|revoke]`; `advisors strategy-context|shared-knowledge [set]`; `campaigns-orchestration workspace|versions|dispatches`; `notifications preferences [set]`; `workflows budget [set|clear]`; `kanban column-limit [clear]|work-item-run`; `job-search answers [set]`.
- `resourceCommands.ts`: a `file` field type (secrets read from a file) and `dispatchSpecs`/`specsUsage` so a hand-written group can serve part of its surface from a spec table.

### Changed

- **Host-proprietary roots under major 2** (`spec/v2/core/versioning.md` §5). When the negotiated major is 2 and discovery advertises an unversioned mount for an org under `extensions.*` (`{ root: "/host/<org>/", twin: "/v1/host/<org>/" }` — the reference host's `openwop-app.host`), a `/v1/host/<org>/…` request is sent to `/host/<org>/…` with **no** `OpenWOP-Version` header (such a path has no major and is outside §1.4). With no advertised root the `/v1` twin is sent unchanged; under major 1 or an `OPENWOP_PROTOCOL_MAJOR` pin nothing is rewritten.
- The single discovery read now carries `OpenWOP-Version: 2`, because only a host's v2 representation carries the §5 `extensions` mount (the header-less default is `preferredVersion`, the v1 document). Still one read per process; a host that does not serve major 2 answers `406` with `details.protocolVersions` (§1.3), which negotiation reads the same way.
- `V2_PATH_TEMPLATES` refreshed from the corpus `spec/v2/path-manifest.json` (corpus `v2.42.6-15-g61b66240`, 45 paths, 43 embedded — adds `/webhooks/{webhookId}/dead-letters` and `/webhooks/{webhookId}/rotate-secret`). New `scripts/sync-path-manifest.mjs <corpus>` (stdlib only) regenerates the list and the checked-in `test/fixtures/v2-path-manifest-paths.json`; `test/path-manifest.test.mjs` fails on drift.
- `consumeSse` parses the `retry:` field and hands `id:`/`retry:`-only blocks to an optional third `onControl` callback; an `id:` containing NUL is ignored (WHATWG). An unterminated final block at a clean close is discarded rather than dispatched, per the WHATWG event-stream interpretation, so a truncated frame cannot advance the resume cursor.
- `podcasts list` now requires `--org` (the host's `GET /podcasts/episodes` rejects a request without `orgId`); `notebooks create`/`podcasts create` now print the id from `body.notebook.id`/`body.episode.id`, where the host returns it.
- `documents render` sends `--format` (previously always an empty body, which the host treats as pdf).

### Fixed

- **Host-extension paths renamed `/v1/host/sample/*` → `/v1/host/openwop-app/*`.** The reference host renamed that namespace in openwop-app PR #260 (2026-06-14); 66 of the CLI's 68 host-extension paths still used the old name and every one 404'd against `https://app.openwop.dev/api` (e.g. `/v1/host/sample/orgs` 404 vs `/v1/host/openwop-app/orgs` 200). The unit tests passed because they mocked fetch and asserted the old literal. Source, tests, README, FEATURES, ARCHITECTURE, ROADMAP and CLAUDE.md updated.
- `kanban watch` opened its SSE stream with a hand-built URL that bypassed `resolveRequest`; it now goes through the same negotiation as every other request.
- **Tenant-bound run ids now travel in the projected wire form under major 2** (`identity.md` §5). A `<tenantId>/<id>` run id was sent as `acme%2Fr1`; a front door that decodes `%2F` before routing (app.openwop.dev's does) split it into two segments and answered `404`. Every `/runs/{runId}…` path (incl. `:fork`, `:diff` and `against=`) now sends `acme~2Fr1` — measured live: `%2F` → 404, `~2F` → 200. Already-projected ids pass through; under major 1 nothing changes. (`src/ids.ts`, one call in `resolveRequest`.)
- **The poll cursor is `afterSequence` under major 2** (`events.md` §Poll — "`lastSequence` and `since` are not parameters"). `runs events --since N` and the SSE-fallback poller sent `lastSequence`, which a v2 host ignores, so every poll replayed from sequence 0. Terminal detection reads v2 `isTerminal` as well as v1 `isComplete`.
- **`interrupts resolve` sends the closed `{ "resumeValue": … }` body** both majors' OpenAPI require; it sent the raw `--data-json` object. A payload that is already exactly `{ "resumeValue": … }` is not double-wrapped.
- **Error messages read the error envelope** (`errors.md`): `HTTP 404 not_found: <message>` instead of `HTTP 404: <message>` — the registered code is what a client routes on. Handles the flat v2/v1 `{ error, message }`, the nested `{ error: { code, message } }` and a bare `{ code }`. `426 client_version_unsupported`, `406 protocol_version_unsupported` (echoing `details.protocolVersions`) and `protocol_version_mismatch` get an actionable hint; a `429` prints its `Retry-After`.
- `reviews list` read `reviews[]`, but the host answers `items[]` — the human table was always empty.
- `reviews action` now exits 1 on `rejected` / 3 on `pending`, as its help promised.
- `governance policy set --retention-graph-days/--retention-source-days` set two windows the host no longer enforces (it strips them and warns). Added `--retention-pii-days` / `--retention-internal-days` (the windows the host's sweep enforces) and the command now prints the host's `warnings`; the old flags are marked deprecated in help.
- `governance media-budget` and the other governance reads/writes now map a 403 to the super-admin message (exit 4) instead of a bare `HTTP 403`.

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
