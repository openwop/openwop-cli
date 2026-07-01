# OpenWOP CLI

The OpenWOP CLI is the local control plane for the [OpenWOP](https://github.com/openwop/openwop) demo app (`apps/workflow-engine`, live at [app.openwop.dev](https://app.openwop.dev)) and a lightweight client for any OpenWOP-compatible host.

This is the standalone home of the `@openwop/cli` package; it ships independently of the [`openwop/openwop`](https://github.com/openwop/openwop) spec corpus.

## Command groups

The CLI is a host-agnostic **control plane**: every group drives one protocol surface a host advertises, and degrades gracefully when the host doesn't serve it. Full catalog in [`FEATURES.md`](./FEATURES.md); shape + boundaries in [`ARCHITECTURE.md`](./ARCHITECTURE.md); what's planned next in [`ROADMAP.md`](./ROADMAP.md).

| Area | Groups |
|---|---|
| **Setup & health** | `onboard` · `doctor` · `demo` · `health` · `capabilities` · `config` · `completion` · `upgrade` |
| **Run lifecycle** | `runs` · `chat` · `interrupts` · `workflows` · `catalog` · `media` |
| **Agents & orchestration** | `agents` · `roster` · `org-chart` · `kanban` · `workforces` (`fleet`) |
| **Governance & safety** | `approvals` · `governance` (`policy`) · `consent` · `toggles` |
| **Identity & access** | `orgs` · `users` · `profiles` · `auth` (`sso`) |
| **Extensibility & connections** | `packs` · `mcp` · `connections` (`conn`) · `providers` · `byok` |
| **Memory & workspace** | `memory` · `workspace` · `prompts` |
| **Automation & messaging** | `cron` · `webhooks` · `messaging` · `relay` · `notifications` · `notify` |
| **Observability & admin** | `analytics` (`usage`) · `account` · `admin` · `brand` · `conformance` |
| **Product surfaces** | `crm` · `csm` · `comments` · `sharing` · `forms` · `email` |

> **Recent sprint (`[Unreleased]`, slated for `0.3.0`):** 11 new groups + a `cron enable/disable` extension surfaced the host's governance/safety, identity, extensibility, orchestration, and observability surfaces — `approvals`, `governance`, `consent`, `toggles`, `users`, `profiles`, `auth`, `mcp`, `connections`, `workforces`, `analytics`. See [`CHANGELOG.md`](./CHANGELOG.md) for the per-group detail.

## Install

One-line install (detects the OS, ensures Node 22+, installs the package, then onboards):

```bash
curl -fsSL https://openwop.dev/install.sh | bash
```

Or directly: `npm i -g @openwop/cli` (needs Node 22+), then `openwop onboard`.

## Quick start

```bash
openwop --help
openwop doctor                 # check prerequisites
openwop onboard                # guided setup (host + provider + key + model)
openwop demo start             # boot local backend + frontend (from inside an openwop checkout)
openwop demo status
openwop catalog nodes --search ai
openwop runs create sample.demo.uppercase --input text=hello --wait
openwop packs search ads        # browse the signed pack registry
```

> The `demo` subcommands operate on an [`openwop/openwop`](https://github.com/openwop/openwop) checkout discovered by walking up from your current directory; run them from inside a clone of that repo.

## Onboarding

The `onboard` wizard walks you through:

1. **Host URL** — `https://app.openwop.dev/api` (shared demo), `http://localhost:8080` (local), or a custom URL.
2. **AI provider** — `anthropic`, `openai`, `google`, or `minimax` (matches what the demo backend dispatches to).
3. **API key** — auto-detects `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `MINIMAX_API_KEY`, or hidden-input via raw-mode stdin. The key is POSTed to `/v1/host/sample/byok/secrets` on the configured host. **The key is never written to your local config file** — only a credential ref pointer is stored.
4. **Model** — provider-specific recommended defaults plus a custom option.
5. **Test the connection** — verifies the credential ref appears in the host's BYOK list.

Re-running `openwop onboard` is safe: it detects existing config and asks Keep / Modify / Reset.

For scripted use:

```bash
openwop onboard --non-interactive \
  --base-url-choice shared \
  --provider anthropic \
  --api-key-env ANTHROPIC_API_KEY \
  --model claude-sonnet-4-6
```

## Provider management

```bash
openwop providers list
openwop providers add openai --api-key-env OPENAI_API_KEY --model gpt-4o
openwop providers remove openai
openwop providers test anthropic
```

`providers add` POSTs to `/v1/host/sample/byok/secrets`; `remove` DELETEs; `list` and `test` read.

## Chat

`openwop chat <workflowId>` opens an interactive streaming REPL. Each message you type creates a run for the workflow carrying the running conversation as a `messages` array, then streams that run's events to the terminal as they arrive.

```bash
openwop chat sample.chat.turn
openwop chat sample.chat.turn --inputs-json '{"credentialRef":"anthropic-default"}'
openwop chat sample.chat.turn --no-stream --json
```

- **Streaming** — prefers Server-Sent Events (`GET /v1/runs/{runId}/events`). When the host does not stream (it answers with JSON or a non-streamable body), the CLI falls back to polling `GET /v1/runs/{runId}/events/poll`.
- **Turns** — type a line and press Enter. Conversation history is threaded across turns; the assistant's reply is fed back as context. Use `--no-history` to send only the latest turn.
- **Quitting** — `/exit`, `/quit`, or Ctrl-D (EOF).
- **`--json`** — emits raw event records (one JSON object per event) instead of the pretty `assistant>` rendering.
- Extra per-turn inputs (`--input k=v`, `--inputs-json`) ride along on every run, so you can pin a `credentialRef`, model, or other configurable input.
## Packs (signed node-pack registry)

```bash
openwop packs search ads                                   # filter the catalog
openwop packs info community.openwop-team.demo             # metadata + versions
openwop packs install community.openwop-team.demo@0.1.0    # download + verify
openwop packs publish ./my-pack --key ~/key.pem --key-id me-1
openwop packs yank community.openwop-team.demo@0.1.0       # local registry edit
```

These talk to the signed node-pack registry — a **separate surface** from the host `--base-url`. The default registry is `https://packs.openwop.dev`; override with `--registry-url` or `OPENWOP_REGISTRY_URL`.

- **search** reads `/v1/index.json` and filters the catalog client-side (the dynamic host `/v1/packs/-/search` only knows in-process nodes, not the published catalog).
- **info** reads `/v1/packs/{name}/index.json`; `--version v` also fetches that version's manifest.
- **install** downloads `/v1/packs/{name}/-/{version}.tgz`, checks its `sha256` against the manifest `integrity`, and verifies the detached Ed25519 `.sig` against the publisher key at `/keys/{keyId}.pub` (matching `signing.method` — `ed25519` signs the tarball, `manual` signs the in-tarball `pack.json`). Skip verification with `--no-verify`. Artifacts land under `~/.openwop/packs/{name}/{version}/` (override with `--dir`). Yanked versions are refused.
- **publish** — the reference registry has **no write API** (`writeApi.supported=false`; publish is a GitHub pull request). This command performs the local **packaging + Ed25519 signing** flow (mirrors `scripts/build-pack-tarball.mjs --signed`): it emits a deterministic signed `.tgz`, a 64-byte `.sig`, and a sidecar manifest into `dist/packs/` (override with `--out`), ready to commit and PR. The private key comes from `--key <pem>`, else `~/.openwop-keys/{keyId}.private.pem`; if neither exists an ephemeral key is generated and its public half printed for pre-registration.
- **yank** edits a **local registry checkout** — flips `"yanked": true` in the version manifest (`--undo` reverses), so the change is ready to commit, rerun `registry/scripts/build-index.mjs`, and PR. Run it from inside the repo.

## Messaging & relay

Connect chat channels (Signal / WhatsApp / iMessage) to the host so inbound messages drive workflow runs and replies are delivered back. Channels are a **host-extension** surface (`/v1/host/sample/messaging`), not part of the normative OpenWOP wire — the protocol stays channel-agnostic.

```bash
openwop relay setup --channel signal        # register + activate a device, store its token
openwop relay start                          # bridge loop: heartbeat → poll outbound → deliver → ack
openwop relay send --conversation +15551234 --text "hi"   # operator-side: queue an outbound
openwop relay status                         # probe the device token against the host
openwop messaging connectors list|add|enable|disable|test
openwop messaging sessions list|inspect|close
openwop messaging policy   get|set <connectorId>          # DM/group access + require-mention
openwop messaging routing  list|add|remove                # inbound match → bound workflow
openwop messaging identity list|show|create|link|unlink|delete   # cross-channel peer linking
openwop messaging logs     [--channel c] [--direction inbound|outbound] [--status s] [--limit n]
openwop notify email --to a@b.dev --text "hi" [--subject S]      # one-off dispatch
openwop notify sms   --to +15551234 --text "pong"
```

The operator subcommands manage the gateway beyond device wiring:

- **policy** — per-connector access: `set <id> --dm <pairing|allowlist|open|disabled> --group <allowlist|open|disabled> --require-mention <true|false>`. `get` returns the host default (DM pairing, groups allowlist-only, mention required) when none is stored.
- **routing** — `add --pattern "*" --workflow <id> [--channel c] [--priority n]` binds matching inbound conversations to a workflow; higher priority wins. `remove <ruleId>` deletes one.
- **identity** — links platform peers across channels into one logical person: `create --name N --peer <channel>:<peerId>`, `link <id> --peer …` (merges, de-duped), `unlink <id> --peer …`, `delete <id>`.
- **logs** — queries the delivery log (inbound ingested / outbound queued), filterable by channel, direction, status; `--limit` is clamped to `[1, 1000]`.
- **notify** — a one-off email/SMS dispatch (`POST …/messaging/notify`). The reference app returns a **synthetic receipt**; wiring a real provider (SES / Twilio) is a host concern.

How it works: the relay device owns the platform connection and bridges it to the host. Inbound messages POST to the host, which runs the bound workflow (default `sample.demo.uppercase`; override with `OPENWOP_MESSAGING_WORKFLOW_ID`) and queues the reply; the device pulls + delivers it. `doctor` reports per-channel readiness:

- **Signal** needs [`signal-cli`](https://github.com/AsamK/signal-cli) on `PATH`.
- **iMessage** needs macOS (Messages signed in + Full Disk Access for `chat.db`).
- **WhatsApp** ships with the channel build (Baileys), not the core CLI.

`relay start` also **receives**: each channel plugin streams inbound platform messages and forwards them to the host's `/device/inbound` (which runs the bound workflow and queues a reply). Signal uses `signal-cli ... receive`, iMessage polls `chat.db` by ROWID, WhatsApp binds Baileys `messages.upsert`. Disable inbound with `--no-receive`. When a channel's tooling isn't present, inbound is skipped and outbound prints to the console instead of silently dropping it.

The relay **device token** is a host credential, so it is stored separately from `config.json` in `~/.openwop/relay-credentials.json` (mode `0600`), not in your main config. Revoke it any time with `openwop relay revoke`.

## Runs

Beyond `runs create` / `list` / `get` / `cancel`, the CLI surfaces a run's full inspection + review surface:

```bash
openwop runs events <runId> [--since <seq>] [--limit n]   # JSON event poll (GET .../events/poll)
openwop runs annotations <runId>                          # list review signals
openwop runs annotate <runId> --rating 5 [--note "great"] # attach a rating/label/correction/flag
openwop runs annotate <runId> --label triage --event-id <id>
openwop runs debug-bundle <runId> [--max-events n] [--out bundle.json]
openwop runs ancestry <runId>                             # RFC 0040 cross-host parent chain
```

`runs events --since N` maps to the spec-canonical `lastSequence` query param (events with `sequence > N`). `runs annotate` posts exactly one signal kind (`--rating 1-5` | `--label` | `--correction` | `--flag`), validated client-side. `runs debug-bundle --out <file>` saves the full event bundle to disk.

## Operator surfaces

Beyond runs/workflows/catalog, the CLI surfaces the host's operator endpoints: `agents`, `memory`, `media`, `webhooks`, `chat`, plus `notifications` (inbox), `interrupts` (list/resolve human-in-the-loop pauses), and `prompts` (RFC 0029 library list/get/render). Every command supports `--json`.

## Agent-platform surfaces

These drive the demo app's protocol-enabled agent surfaces (each `--help` cites its RFC + endpoint):

```bash
openwop roster list                          # named standing agents + workflow portfolio (RFC 0086)
openwop roster create --persona "Sally" --agent-ref core.x.agent --workflow sample.demo.triage
openwop org-chart get                         # descriptive departments/reporting (RFC 0087)
openwop org-chart set --file ./org.json       # replace the chart (departments[] + members[])
openwop kanban boards                         # agent task boards
openwop kanban board-create --name "Sally's work" --roster r_123
openwop kanban card-add b_1 --title "Triage" --column todo
openwop kanban watch b_1                       # stream a board's card events (SSE)
openwop orgs list                             # organizations + RBAC (RFC 0049)
openwop orgs teams|groups|roles|members <orgId> list|create|update|delete
openwop orgs effective --subject user:jo      # resolve a subject's effective access
openwop workspace list                        # per-tenant agent workspace files (RFC 0059)
openwop workspace put notes/todo.md --content "- ship it"
openwop byok list                             # BYOK credential refs (never values)
openwop byok set --ref anthropic-prod         # prompts for the secret (no shell history)
openwop agents create --persona "Triage bot" --model-class fast   # user-defined agent CRUD
openwop brand public                          # the applied white-label identity (anonymous)
openwop brand set --accent 'oklch(58% 0.13 250)' --product-name 'Acme Ops'   # generative theme (super-admin)
```

Destructive commands (`roster delete`, `kanban board-delete`/`card-delete`, `orgs … delete`, `workspace delete`, `byok delete`, `agents delete`) require an explicit `--yes`.

Two maintenance commands guard destructive operations behind a confirmation prompt (default *no*, bypass with `--confirm`):

```bash
openwop account delete                 # irreversibly wipe ALL data for the signed-in account
openwop admin cleanup                   # wipe expired ephemeral secrets for idle tenants
openwop admin cleanup --status          # read-only liveness probe
```

`account delete` requires a signed-in user (OIDC bearer). `admin` routes are gated by the host's `OPENWOP_ADMIN_TOKEN` — pass it via `--api-key`.

## Governance

Tenant governance administration (ADR 0028 — a superadmin-gated host extension). The host is the policy authority; the CLI only **renders** its resolved view and never evaluates a policy outcome locally. Because the surface is non-normative (not advertised in `/.well-known/openwop`), the command **fails closed legibly** (exit 2) when a host doesn't expose it.

```bash
openwop governance policy                        # render stored policy + the host's declared defaults
openwop governance policy get --json             # raw host view
openwop governance policy set --action email.send=approval-required --action nudge=disabled
openwop governance policy set --provider-allowlist anthropic,openai --retention-graph-days 90
openwop governance audit --prefix governance. --limit 20   # tenant-scoped audit read view
```

Action kinds are `email.send`, `calendar.invite`, `calendar.reschedule`, `nudge`; policies are `disabled | draft-only | approval-required` (unset kinds fall back to the host's declared default). Aliased as `openwop policy`.
The `approvals` group drives the host's approval inbox — the human side of "agents propose, humans dispose". A review-mode roster member's heartbeat queues a proposal instead of starting the run; you resolve it here:

```bash
openwop approvals list --status pending        # the queue (also: approved | rejected)
openwop approvals get appr_123 --json          # inspect one proposal
openwop approvals claim appr_123 --note "LGTM" # affirmative sign-off → starts the run
openwop approvals reject appr_123              # dismiss the proposal (alias: deny)
```

The host is the authority for every decision: the CLI renders the host's resolved queue and relays your claim/reject — it never decides locally, and fails closed if the host doesn't advertise the surface. Exit codes reflect the verdict so scripts can gate on it: `0` approved · `3` pending · `1` rejected/error. (Distinct from `interrupts`, which are run-level HITL tokens.)
## Consent (privacy / GDPR)

`consent` drives the host's tenant-scoped, region-aware consent surface (ADR 0020). The host is the authority — the CLI **renders** its resolved view and never computes a consent decision itself; when the org-tenant's `consent` toggle is off the host returns a uniform 404 and the command fails closed with a legible message.

```bash
openwop consent policy <orgId>                                   # show the tenant policy (defaultMode + regulated regions)
openwop consent set-policy <orgId> --default-mode opt-out --regulated-region EU --regulated-region UK
openwop consent records <orgId> --json                           # list all consent records for the tenant
openwop consent get <orgId> <subjectKey>                         # one subject's record (or none)
openwop consent erase <orgId> <subjectKey> --yes                 # GDPR erasure (irreversible; --yes required)
openwop consent public get <orgId> <subjectKey>                  # public, unauthed: a visitor's recorded categories (or the policy default)
openwop consent public record <orgId> <subjectKey> --category analytics=true --category marketing=false
```

Exit codes: `0` success · `1` host/HTTP error (including consent not enabled) · `2` usage error.

## MCP server mount

An MCP client for the host's JSON-RPC server mount (RFC 0020) — a single JSON-RPC 2.0 endpoint at `POST /v1/host/sample/mcp` speaking modelcontextprotocol.io 2025-06-18. The mount is **host-controlled**: it's env-gated (`OPENWOP_MCP_SERVER_ENABLED`, **OFF by default**) and the CLI cannot toggle it. When the mount isn't exposed the endpoint 404s and these commands **fail closed legibly** (exit 2).

```bash
openwop mcp ping                                  # liveness probe of the mount
openwop mcp info --json                           # initialize: server/protocol/capabilities
openwop mcp tools list                            # workflows exposed as MCP tools
openwop mcp tools call sample.demo.uppercase --args '{"text":"hi"}'
openwop mcp resources list                        # + `templates` / `read <uri>`
openwop mcp prompts get greet --args '{"name":"Ada"}'
```

`--json` emits the raw JSON-RPC result on any read. JSON-RPC errors surface the host's own message (contract errors → exit 2, host errors → exit 1); a tool whose result is `isError` exits 1.

The `connections` group (alias `conn`) inspects the host's third-party connections and their OAuth client configuration (ADR 0024):

```bash
openwop connections list                       # connections + status
openwop connections test conn:abc              # health-probe (exit 0 healthy / 1 not)
openwop connections authorize google --scope https://www.googleapis.com/auth/calendar --write
openwop connections oauth-clients list          # host-configured OAuth apps (superadmin)
```

`authorize` mints a consent URL and **prints it only** — the CLI never completes the OAuth round-trip (the browser + host callback do). **Secrets stay host-side:** client secrets and tokens are never returned, printed, or logged — the CLI runs every response through a recursive redactor before output, surfacing refs and status only.
## Profiles (self-service persona)

`profiles` drives the host's user-profile surface (ADR 0005): your job title, bio, contact, skills, availability, portfolio, and pinned agents. The host is the authority and the CLI renders its resolved view — reads are visible to any signed-in tenant member, **writes only ever touch your own profile**. Requires a durable signed-in account (bearer via `--api-key`).

```bash
openwop profiles me                                              # your own profile
openwop profiles get <userId>                                    # a tenant member's profile (team-visible)
openwop profiles list                                            # the tenant persona directory
openwop profiles edit --job-title "Staff Engineer" --availability-status busy --timezone Europe/London
openwop profiles skills set --skill TypeScript=5 --skill Rust=3  # replace your skill list (proficiency 1..5)
openwop profiles endorse <userId> <skill>                        # endorse a peer's skill (unendorse to remove)
openwop profiles pin <rosterId>                                  # pin/unpin an agent to your sidebar
openwop profiles portfolio add --token <mediaToken>              # attach an image asset (remove <token> to drop)
openwop profiles activity --limit 10 --status failed             # your run-activity feed
```

**Boundary:** `profiles` is the persona/skills surface — **not** the user directory (account lifecycle) and **not** RBAC (that's `orgs`). Exit codes: `0` success · `1` host/HTTP error (incl. not found / not signed in) · `2` usage error.
## Users (identity directory + lifecycle)

`users` drives the host's tenant identity directory and account lifecycle (ADR 0002). It is the durable record of **who** exists in a tenant and whether their account is active — **not** authorization (role/permission membership lives in `orgs`) and **not** editable persona (that's `profiles` / `users me`). The `groups` field is the raw IdP `groups[]` captured at sign-in for the RBAC handoff; it grants nothing by itself. The host is the authority: the surface 404s when not served (fail closed, exit 2), and a disabled account is denied 403.

```bash
openwop users list                                              # the tenant's users
openwop users me                                                # your own durable record
openwop users me --display-name "Ada L."                        # self-serve rename (PATCH /me)
openwop users create --principal oidc:abc123 --email a@b.dev --group eng --source oidc
openwop users get <userId> --json
openwop users update <userId> --display-name "Ada" --group eng --group oncall   # groups replace; --email '' clears
openwop users disable <userId>                                  # lifecycle (fail-closed control)
openwop users enable <userId>
openwop users delete <userId> --yes                             # irreversible; --yes required
```

Identity `source` is one of `oidc | password | saml | scim | manual`. Exit codes: `0` ok · `1` host error · `2` usage / surface not served / account disabled.

## Feature toggles

`toggles` renders the caller's **resolved** feature-toggle assignments (a non-normative host extension under `/v1/host/sample/feature-toggles/assignments`). The **host** is the sole authority — it resolves every toggle server-side from the authenticated principal — and the CLI only *displays* what the host returns. It **never** computes, asserts, or overrides a toggle decision locally, and it does not author config (the superadmin config surface is intentionally not exposed). When the host doesn't serve the surface the command fails closed (exit 2).

```bash
openwop toggles list                                             # every toggle's resolved state for you (incl. off)
openwop toggles list --json                                      # raw host view
openwop toggles get crm.triageAgent                             # one toggle: status / enabled / variant / bindings
```

Resolved fields are host-authored: `status` (`on | off | beta`), `enabled` (bool), assigned `variant`, and the variant's `bindings` (slot → ref@version). Exit codes: `0` ok · `1` host error · `2` usage / surface not served / unknown toggle.

The `workforces` group (alias `fleet`) drives the host's durable multi-agent orchestration — a *Governed Workforce* is a bundle of agent specs with graduated-autonomy posture and aggregate telemetry:

```bash
openwop workforces list                         # governed workforces + status
openwop fleet metrics wf_support                # aggregate telemetry (runs, rates, cost)
openwop workforces governance wf_support        # autonomy graduation + governance posture
openwop workforces trace wf_support --q batch_42 # cross-run trace/audit search
openwop workforces status wf_support production  # request a cutover (host gates on graduation)
```

This group **composes with** `kanban` (task boards) and `roster` (standing agents) but does not duplicate them — it renders the workforce's governance/metrics view, never re-modelling boards or roster entries. The host is the authority; the CLI renders its resolved view and fails closed if the surface isn't advertised. `status production` is gated host-side on the workforce having graduated to bounded-autonomous (a 409 surfaces legibly); `eval` needs the host's eval suite enabled.

## Enterprise SSO (SAML / SCIM)

`auth` (alias `sso`) drives the host's enterprise identity surface (RFC 0050). The host is the authority; the CLI surfaces **status, public SP metadata, and provisioning results only**. SAML signing certs, SCIM bearer tokens, and client secrets are host-side and are never printed — every response is run through a recursive redactor before output (the public SP metadata XML, meant to be uploaded to your IdP, is the deliberate exception).

```bash
openwop auth status                                              # which SSO/SCIM profiles this host advertises + whether SAML SSO is live
openwop auth saml metadata                                       # SP metadata XML to upload to your IdP
openwop auth saml login-url --return-to /dashboard               # the SP-initiated IdP redirect URL (not followed)
openwop auth saml validate --idp-url http://localhost:9100/idp --variant valid   # conformance: validate a synthetic-IdP assertion
openwop auth scim provision --op create-user --user-name jo@acme.com --email jo@acme.com
```

`auth status` trusts discovery (`/.well-known/openwop`) as authoritative — an unadvertised profile is never probed, so a host's SPA catch-all can't false-report a surface as live. Each surface fails closed with a legible message when the host hasn't configured it.

**Boundary:** `auth` is SSO/SAML/SCIM identity-provider config — **not** the user directory (`users`), RBAC (`orgs`), or BYOK provider credentials (`byok`/`providers`). Exit codes: `0` success (`saml validate`: `0` = authenticated) · `1` host error / not configured (`saml validate`: `1` = rejected) · `2` usage error.
## Analytics (usage)

`analytics` (alias `usage`) reads a host's org-scoped usage analytics (ADR 0018). The **host** aggregates server-side and gates each org read by RBAC (`workspace:read`) plus the org-tenant's `analytics` toggle; the CLI only **renders** the rollup it returns — it never computes usage locally — and fails closed (exit 2) when analytics isn't served. This is **usage / cost / observability**, deliberately distinct from `governance audit` (the policy-decision log) — hence the alias is `usage`, not `audit`.

```bash
openwop analytics summary <orgId>                               # aggregate rollup (total, sessions, by-type, top paths, utm)
openwop usage events <orgId> --json                             # recent raw events (max 100)
openwop analytics collect <orgId> --session s_abc --type pageview --path /pricing   # public consent-gated beacon
```

The `collect` beacon is **public** (sent without auth) and consent-gated host-side: a `201` records the event; a `202` honestly reports that analytics consent wasn't granted (nothing recorded). Event type is one of `pageview | event | conversion`. Exit codes: `0` ok · `1` host error · `2` usage / analytics not served / not authorized.

### Reviewable-learning proposals (`proposals`, RFC 0096)

The `proposals` group drives the host's reviewable-learning proposal lifecycle. An agent's learned change lands as an **inert** proposal — a stored artifact draft that does nothing until a human reviews and applies it. The **host** is the authority: `apply` asks it to materialize the byte image last persisted on the proposal (no re-synthesis) and route activation through its advertised mode (e.g. an RFC 0051 approval-gate); the CLI never activates locally.

```bash
openwop proposals list --state pending                 # the review queue (also --kind <artifactKind>)
openwop proposals get prop_123 --json                  # inspect one proposal
openwop proposals revise prop_123 --artifact-json '{"systemPrompt":"…"}'  # edit the draft (never activates)
openwop proposals apply prop_123                       # host materializes + routes through its activation gate
openwop proposals reject prop_123 --note "out of scope"
openwop proposals archive prop_123 --yes               # soft-delete
```

Capability-gated on `agents.proposals` (advertised in `/.well-known/openwop`); fails closed (exit 1) when the host doesn't serve the surface. Boundary: distinct from `approvals` (the human run-action queue) — proposals are the artifact *drafts* reviewed before they become live behavior. Exit codes (get/apply/reject reflect the verdict): `0` applied · `3` pending (in review) · `1` rejected/archived or error.

### Standing goals (`goals`, RFC 0097)

The `goals` group drives the host's standing goals — an objective the host pursues across runs until a **judge** (RFC 0090) verdicts it satisfied or a **bound** (RFC 0058) stops it. **Completion is the judge's verdict**: there is no `complete`/`satisfy` verb and the CLI never sets `satisfied` — you cannot declare victory from the client.

```bash
openwop goals list --state active                      # the goal list (also satisfied | escalated | bound-exceeded | paused)
openwop goals get goal_123 --json                      # inspect (objective, judge, continuation, bounds, iterations)
openwop goals create --objective "Keep the triage backlog under 20" \
  --judge verifier --continuation schedule --max-iterations 50 --max-cost 5.00 --timeout-ms 600000
openwop goals pause goal_123                            # suspend continuation (resume to restart)
openwop goals abandon goal_123 --yes                   # close the goal
```

A bounds-less goal is rejected `422` when the host advertises `requiresBounds` — pass `--max-iterations`/`--max-cost`/`--timeout-ms`. The create body maps to the Goal entity shape (`completion.check` / `continuation.mode` / `bounds.{maxLoopIterations,runTimeoutMs,maxCostUsd}`). Capability-gated on `agents.goals`; fails closed (exit 1) when the surface isn't served. Boundary: a goal is **not** an RFC 0068 commitment — it *uses* a commitment/schedule/heartbeat as a continuation arm and adds a judge loop + termination guarantee. Exit codes: `0` satisfied · `3` escalated or still open (active/paused) · `1` bound-exceeded/abandoned or error.

### Agent-platform portability — `export` / `import` (RFC 0098)

Move reusable estate (agents, packs, schedules, rosters, templates) between hosts as a portable bundle. **Secrets are refs, never values:** the bundle carries only `secretsToRebind` references — never credential material — and the host rejects a bundle that smuggles a literal credential before it applies anything. Always **dry-run first**.

```bash
openwop export --json                                  # the full refs-only bundle
openwop export --kinds agent --kinds schedule --out estate.json   # filtered, to a file
openwop import estate.json --dry-run                   # preview: creates/updates/skips/conflicts (no writes)
openwop import estate.json                             # apply (idempotent; entities re-owned to you)
```

The CLI runs every response through a secret redactor before printing or writing to disk (defense-in-depth on top of the host's refs-only guarantee). Capability-gated on top-level `portability`; fails closed when the host doesn't serve the surface. This subsumes the old SPA-only `migrate-tenant` bootstrap. Import exit codes: `0` applied (or a clean dry-run plan) · `2` the plan has conflicts (nothing overwritten) · `1` error — a literal credential or `dependsOn` cycle (422), or no import scope (403).

### External-event trigger subscriptions (`triggers`, RFC 0099)

The `triggers` group drives the host's **normative** trigger bridge: a subscription binds an external source (`webhook` / `email` / `form`) to a workflow the caller can start, and a verified inbound event then starts a run with the event as `ctx.triggerData`.

```bash
openwop triggers register --source webhook --workflow wf_intake --dedup --verification required
openwop triggers list --state active
openwop triggers get sub_123 --json
```

`register` returns the created subscription plus its source `binding` (the ingest URL/address). A webhook **binding secret is shown once** — store it then; the CLI never persists it and re-reads return only the `secretFingerprint`. Capability-gated on `capabilities.triggerBridge` (register also honesty-gates on `triggerBridge.ingestion.externalSources`); fails closed when absent. Exit codes: `0` active · `3` paused · `1` failed/dead-lettered or error.

### Async / durable A2A tasks (`a2a`, RFC 0100)

When a host advertises `capabilities.a2a.durableTasks`, every backing run has a durable `A2ATaskState` (taskId === runId) readable after the caller disconnects.

```bash
openwop a2a status                    # what the host advertises (supported/streaming/push/durableTasks)
openwop a2a task run_abc123 --json    # the durable task's live state
```

The record is content-free by design (state, `interruptKind`, push config — never run inputs/outputs/credentials); the CLI renders the host's resolved state and never derives one locally. Gated on `capabilities.a2a` (the durable read needs `durableTasks: true`). `task` exit codes: `0` completed · `3` submitted/working/input-required/auth-required · `1` failed/canceled/rejected or error.

## Config

`~/.openwop/config.json` (or `$OPENWOP_CONFIG_HOME/.openwop/`) stores the host URL, default provider, default model, and credential ref. **API keys are never stored locally.**

```bash
openwop config file                      # print path
openwop config get                        # print full config
openwop config get host.baseUrl           # dotted-path lookup
openwop config set defaultModel gpt-4o
openwop config unset credentialRef
```

## Defaults

- Host URL: `--base-url` > `OPENWOP_BASE_URL` > **saved config** (`onboard`'s `~/.openwop/config.json`) > `http://localhost:8080`. After `onboard`, everyday commands use the saved host with no flag.
- Profiles: `--profile <name>` (or `OPENWOP_PROFILE`) selects `~/.openwop-<name>/config.json`, so you can keep prod/staging/local hosts side by side.
- OpenWOP host bearer (NOT the LLM provider key): `--api-key` > `OPENWOP_API_KEY` > saved config > `sample-token` for localhost demo URLs.
- Shell completion: `openwop completion <bash|zsh|fish>`. Update check: `openwop upgrade`.
- LLM provider key: `--provider-key <key>` or `--api-key-env <VAR>` on `onboard` / `providers add` (not stored locally).
- Frontend URL: `http://localhost:5173`.

Input parsing for `runs create`:

- `--input k=v` — each value is `JSON.parse`d first; on parse failure it falls back to a string. So `--input n=5` is the number `5`, `--input enabled=true` is the boolean `true`, `--input text=hello` is the string `"hello"`, and `--input list=[1,2,3]` is an array. Quote shell-special characters.
- `--inputs-json '{"a":1}'` passes the whole `inputs` object as one JSON literal. Merged BEFORE `--input` pairs (which override).
- `--wait` polls `GET /v1/runs/{runId}` every 250ms until terminal status or `--timeout-ms` (default 30000) elapses. Exit 0 only on `completed`.

Exit codes:

- `0` — success.
- `1` — server-side failure (5xx) or run terminated in `failed` / `cancelled` under `--wait`.
- `2` — user-fixable error (unknown command, missing argument, 4xx response).

The CLI is dependency-light by design. It uses Node built-ins so contributors can operate the demo app without installing another command framework.

## Development

This repo is a self-contained TypeScript package (the build is `esbuild`; it does not depend on the spec corpus). Requires Node ≥ 20.

```bash
npm ci
npm run typecheck     # tsc --noEmit (strict, noImplicitAny)
npm run build         # → dist/openwop.js (esbuild bundle)
npm test              # build + node --test test/*.test.mjs
node dist/openwop.js --help   # run the local build
```

CI (`.github/workflows/ci.yml`) runs typecheck + tests on every push and PR.

## Releasing

The package publishes to npm via an OIDC **trusted publisher** with provenance — no tokens in CI. Pushing a `vX.Y.Z` tag triggers `.github/workflows/publish.yml`, which builds, tests, and publishes `@openwop/cli@X.Y.Z` (idempotent: it skips if that version is already on npm).

1. Bump `version` in `package.json` **and** `VERSION` in `src/constants.ts` (kept in lockstep), add a `CHANGELOG.md` entry.
2. Commit (DCO-signed), then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.

> **One-time setup (maintainer):** register this repo + `publish.yml` as the trusted publisher for `@openwop/cli` on npmjs.com (package → Settings → Trusted Publishers). The package was previously published from `openwop/openwop`; the binding must be repointed here before the first release.

## Contributing

Commits must be [DCO](https://developercertificate.org/) signed off (`git commit -s`). Follow [Conventional Commits](https://www.conventionalcommits.org/). Licensed under Apache-2.0 (see [`LICENSE`](./LICENSE)).
