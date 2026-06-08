# Changelog

All notable changes to `@openwop/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the CLI is independently
versioned on its own SemVer line (currently `0.x`).

## [Unreleased]

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
