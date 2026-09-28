import type { Ctx } from '../context.js';
/** `openwop packs ...` — operate the signed node-pack registry (C-5). */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { parseJsonResponse } from '../api.js';
import { requireRepoRoot } from '../repo.js';
import { DEFAULT_REGISTRY_URL } from '../constants.js';
import { normalizeBaseUrl, parseNodeVersion } from './shared.js';

export const PACKS_HELP = `Usage:
  openwop packs search [query] [--registry-url url] [--tree v1|v2] [--limit n] [--json]
  openwop packs info <name> [--version v] [--registry-url url] [--tree v1|v2] [--json]
  openwop packs install <name>[@version|@range] [--version v] [--dir path] [--no-verify] [--registry-url url] [--tree v1|v2] [--json]
  openwop packs publish <dir> [--key ed25519.pem] [--key-id id] [--out dir] [--tree v1|v2] [--json]
  openwop packs yank <name>[@version] [--version v] [--undo] [--tree v1|v2] [--json]

Operates the signed node-pack registry (default: https://packs.openwop.dev,
override with --registry-url or OPENWOP_REGISTRY_URL). The registry is a
separate surface from the host --base-url.

Every registry path is resolved through the registry's
/.well-known/openwop-registry.json \`endpoints\` map (spec/v2/core/packs.md
§"The registry tree"), preferring the v2 tree (\`endpoints.v2\`). The v1 tree
is used only when the registry names no v2 tree (or publishes no discovery
document), or when you pass --tree v1.

  search    Reads the registry index (endpoints.registryIndex, /v2/index.json on
            packs.openwop.dev) and filters the catalog client-side.
  info      Reads the pack index (endpoints.packMetadata) + the version manifest
            with --version.
  install   Resolves the version, downloads the tarball, checks its sha256
            integrity against the manifest, and verifies the signature (skip
            with --no-verify). v2: the detached Ed25519 .sig over the in-tarball
            pack.json (RFC 8785 canonical JSON), under the registry key named by
            signing.keyId, whose permittedNamespaces must cover the pack name.
            Places the tarball + manifest under ~/.openwop/packs/{name}/{version}/
            (override with --dir).
            Version: none = the pack's latest unyanked version; a range (^1.2,
            ~1.2.0, 1.x, >=1.0.0 <2.0.0) = the highest matching unyanked version;
            an exact version is a pin and MAY install a yanked version (with a
            warning). A deprecated version installs with a warning.
  publish   The reference registry has NO write API (publish is PR-based). This
            packages + Ed25519-signs a local pack dir into a signed tarball +
            sidecars, ready to commit + open a PR against openwop-registry. The
            default (v2) signing block is { keyId, scheme: "ed25519-canonical-json" };
            --tree v1 writes the legacy v1 block. Private key: --key, else
            ~/.openwop-keys/{keyId}.private.pem.
  yank      Edits a local registry checkout — flips "yanked": true in the version
            manifest under registry/v2/ (--tree v1 for the frozen v1 tree;
            --undo reverses). The published change lands via PR + a
            build-index.mjs rerun. Run from inside the repo.

Exit codes: 0 ok · 1 verification / integrity / resolution failure · 2 usage.
`;

export async function runPacks(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  const args = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  switch (sub) {
    case 'search':
      return runPacksSearch(ctx, args);
    case 'info':
      return runPacksInfo(ctx, args);
    case 'install':
      return runPacksInstall(ctx, args);
    case 'publish':
      return runPacksPublish(ctx, args);
    case 'yank':
      return runPacksYank(ctx, args);
    default:
      throw new CliError(`Unknown packs command: ${sub}\nRun \`openwop packs --help\` for usage.`);
  }
}

function registryUrlFor(options: any, env: any) {
  return normalizeBaseUrl(options.registryUrl ?? env.OPENWOP_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
}

type RegistryTree = 'v1' | 'v2';

/** A registry resolved through its discovery document: which tree, and that tree's path templates. */
export interface RegistryView {
  url: string;
  tree: RegistryTree;
  /** Path templates (`{name}`, `{version}`, `{keyId}`) for the chosen tree, plus the unversioned `publicKey`. */
  endpoints: Record<string, string>;
  /** `signingKeys[]` from the discovery document; null when the registry published none. */
  signingKeys: any[] | null;
  /** How the tree was chosen, for --json output and error messages. */
  source: 'endpoints.v2' | 'endpoints.v1' | 'legacy-v1';
}

const REQUIRED_ENDPOINTS = ['registryIndex', 'packMetadata', 'versionManifest', 'versionTarball', 'versionSignature'];

/**
 * The v1 layout, used ONLY when a registry publishes no discovery document
 * (a pre-`endpoints` registry). A registry that publishes one is always read
 * through it (packs.md §"The registry tree": a client MUST resolve every
 * registry path through `endpoints` rather than construct one).
 */
const LEGACY_V1_ENDPOINTS: Record<string, string> = {
  registryIndex: '/v1/index.json',
  packMetadata: '/v1/packs/{name}/index.json',
  versionManifest: '/v1/packs/{name}/-/{version}.json',
  versionTarball: '/v1/packs/{name}/-/{version}.tgz',
  versionSignature: '/v1/packs/{name}/-/{version}.sig',
  publicKey: '/keys/{keyId}.pub',
};

function treeOption(options: any): RegistryTree | undefined {
  if (options.tree === undefined) return undefined;
  if (options.tree !== 'v1' && options.tree !== 'v2') throw new CliError(`--tree must be v1 or v2 (got "${options.tree}").`);
  return options.tree;
}

function stringTemplates(value: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string' && !k.startsWith('_')) out[k] = v;
  return out;
}

/**
 * Read `/.well-known/openwop-registry.json` and pick a tree: `endpoints.v2`
 * when the registry names one (or `--tree v2`), else the v1 templates
 * (`endpoints.v1`, or the flat v1-era aliases). `publicKey` is unversioned
 * (keys are not protocol-versioned) and is read from the flat map.
 */
export async function resolveRegistry(ctx: Ctx, options: any): Promise<RegistryView> {
  const url = registryUrlFor(options, ctx.env);
  const forced = treeOption(options);
  let doc: any = null;
  try {
    doc = await registryJson(ctx, url, '/.well-known/openwop-registry.json');
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
  }
  const endpoints = doc && typeof doc.endpoints === 'object' ? doc.endpoints : null;
  if (!endpoints) {
    if (forced === 'v2') throw new CliError(`${url} publishes no /.well-known/openwop-registry.json endpoints map, so no v2 tree can be resolved.`, 1);
    return { url, tree: 'v1', endpoints: { ...LEGACY_V1_ENDPOINTS }, signingKeys: null, source: 'legacy-v1' };
  }
  const flat = stringTemplates(endpoints);
  const publicKey = flat.publicKey ?? LEGACY_V1_ENDPOINTS.publicKey;
  const v2 = stringTemplates(endpoints.v2);
  const hasV2 = REQUIRED_ENDPOINTS.every((k) => typeof v2[k] === 'string');
  let tree: RegistryTree;
  let map: Record<string, string>;
  let source: RegistryView['source'];
  if (forced === 'v2' || (forced === undefined && hasV2)) {
    if (!hasV2) throw new CliError(`${url} names no v2 tree in its discovery document (endpoints.v2); retry with --tree v1.`, 1);
    tree = 'v2'; map = v2; source = 'endpoints.v2';
  } else {
    const v1 = stringTemplates(endpoints.v1);
    tree = 'v1'; map = { ...flat, ...v1 }; source = 'endpoints.v1';
  }
  for (const k of REQUIRED_ENDPOINTS) {
    if (typeof map[k] !== 'string') throw new CliError(`${url}'s discovery document names no ${tree} "${k}" endpoint.`, 1);
  }
  return { url, tree, endpoints: { ...map, publicKey }, signingKeys: Array.isArray(doc.signingKeys) ? doc.signingKeys : null, source };
}

/** Fill a discovery template; every parameter is one encoded path segment. */
export function registryPath(view: RegistryView, key: string, params: Record<string, string> = {}): string {
  const template = view.endpoints[key];
  if (typeof template !== 'string') throw new CliError(`${view.url}'s discovery document names no "${key}" endpoint.`, 1);
  return template.replace(/\{([A-Za-z]+)\}/g, (_m, p) => {
    if (params[p] === undefined) throw new CliError(`Registry endpoint ${key} needs {${p}}.`, 1);
    return encodeURIComponent(params[p]);
  });
}

async function registryJson(ctx: Ctx, registryUrl: any, path: any) {
  const url = new URL(path, registryUrl + '/');
  const res = await ctx.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  const text = await res.text();
  const body = text.length > 0 ? parseJsonResponse(text) : null;
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, body);
  return body;
}

async function registryBytes(ctx: Ctx, registryUrl: any, path: any) {
  const url = new URL(path, registryUrl + '/');
  const res = await ctx.fetchImpl(url, { method: 'GET', headers: { accept: 'application/octet-stream' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(`HTTP ${res.status}`, res.status, text ? parseJsonResponse(text) : null);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function runPacksSearch(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--registry-url', '--limit', '--tree'],
  });
  if (options.help) {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  const query = String(positionals[0] ?? '').toLowerCase();
  const registry = await resolveRegistry(ctx, options);
  // The canonical file-backed registry serves the full catalog at its
  // registryIndex; we filter client-side. (The dynamic demo backend's
  // /v1/packs/-/search only knows in-process nodes — not the published
  // catalog — so the index is the authoritative search source.)
  const index = await registryJson(ctx, registry.url, registryPath(registry, 'registryIndex'));
  const packs = Array.isArray(index?.packs) ? index.packs : [];
  const matched = packs.filter((p: any) => {
    if (!query) return true;
    const haystack = [p.name, p.description, ...(p.tags ?? []), ...(p.typeIds ?? [])]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
  const limit = Number(options.limit ?? 30);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { query: positionals[0] ?? '', tree: registry.tree, total: matched.length, packs: matched });
    return 0;
  }
  if (matched.length === 0) {
    writeLine(ctx.io.stdout, query ? `No packs match "${positionals[0]}".` : 'Registry is empty.');
    return 0;
  }
  const rows = matched.slice(0, limit).map((p: any) => ({
    name: p.name,
    version: p.latestVersion ?? '',
    kind: p.kind ?? 'node',
    license: p.license ?? '',
    flags: p.yanked ? 'yanked' : p.deprecated ? 'deprecated' : '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['name', 'version', 'kind', 'license', 'flags']));
  if (matched.length > rows.length) {
    writeLine(ctx.io.stdout, `... ${matched.length - rows.length} more. Use --limit ${matched.length} or --json.`);
  }
  return 0;
}

async function runPacksInfo(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--registry-url', '--version', '--tree'],
  });
  if (options.help) {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  const name = positionals[0];
  if (!name) throw new CliError('packs info requires a pack name.\nUsage: openwop packs info <name> [--version v]');
  const registry = await resolveRegistry(ctx, options);
  const pack = await packMetadata(ctx, registry, name);

  // When a specific --version is given, also fetch its version manifest so
  // callers see the per-version detail (signing key, integrity).
  let versionManifest = null;
  if (options.version) {
    versionManifest = await registryJson(ctx, registry.url, registryPath(registry, 'versionManifest', { name, version: options.version }));
  }

  if (ctx.json) {
    writeJson(ctx.io.stdout, versionManifest ? { ...pack, requestedVersion: versionManifest } : pack);
    return 0;
  }
  const lines = [
    `Name:        ${pack.name}`,
    `Kind:        ${pack.kind ?? 'node'}`,
    `Latest:      ${pack.latest ?? '(none)'}`,
    `License:     ${pack.license || '—'}`,
    `Author:      ${pack.author || '—'}`,
    `Description: ${pack.description || '—'}`,
    `Tree:        ${registry.tree}`,
  ];
  if (pack.homepage) lines.push(`Homepage:    ${pack.homepage}`);
  lines.push('');
  const versions = Array.isArray(pack.versions) ? pack.versions : [];
  if (versions.length > 0) {
    writeLine(ctx.io.stdout, lines.join('\n'));
    const rows = versions.map((v: any) => ({
      version: v.version,
      keyId: v.signingKeyId ?? '',
      flags: versionFlags(v),
      integrity: typeof v.integrity === 'string' ? v.integrity.slice(0, 24) + '…' : '',
    }));
    writeLine(ctx.io.stdout, formatTable(rows, ['version', 'keyId', 'flags', 'integrity']));
  } else {
    writeLine(ctx.io.stdout, lines.join('\n'));
  }
  return 0;
}

/** The pack index, with a 404 named for what it means. */
async function packMetadata(ctx: Ctx, registry: RegistryView, name: string) {
  try {
    return await registryJson(ctx, registry.url, registryPath(registry, 'packMetadata', { name }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new CliError(`No pack named ${name} on ${registry.url} (${registry.tree} tree). Try \`openwop packs search\`.`, 2);
    throw err;
  }
}

/** `yanked` / `deprecated` — v2 names the per-version flag `versionDeprecated`, v1 `deprecated`. */
function versionFlags(v: any): string {
  return v?.yanked ? 'yanked' : v?.versionDeprecated || v?.deprecated ? 'deprecated' : '';
}

async function runPacksInstall(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--no-verify'],
    value: ['--registry-url', '--version', '--dir', '--tree'],
  });
  if (options.help) {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  // Accept either `name@version` or `name --version v`.
  let name = positionals[0];
  let requested = options.version;
  if (name && name.includes('@')) {
    const at = name.lastIndexOf('@');
    requested = requested ?? name.slice(at + 1);
    name = name.slice(0, at);
  }
  if (!name) throw new CliError('packs install requires a pack name.\nUsage: openwop packs install <name>[@version] [--version v]');
  const registry = await resolveRegistry(ctx, options);
  const warnings: string[] = [];

  // Resolve the version (packs.md §"Version manifests", RFC 0222 §B): an exact
  // version is a pin and MAY resolve a yanked version; `latest` and a range
  // never do.
  let version: string;
  if (requested && isExactVersion(requested)) {
    version = requested;
  } else {
    const pack = await packMetadata(ctx, registry, name);
    version = resolveVersion(name, pack, requested);
  }

  // Fetch the version manifest (carries the signing block + integrity).
  const manifest = await registryJson(ctx, registry.url, registryPath(registry, 'versionManifest', { name, version }));
  if (manifest?.yanked) {
    warnings.push(`${name}@${version} is yanked${manifest.yankedReason ? ` (${manifest.yankedReason})` : ''}; installing it because it was pinned exactly.`);
  }
  if (manifest?.versionDeprecated || manifest?.deprecated) {
    const reason = manifest.deprecationReason ?? (typeof manifest.deprecated === 'string' ? manifest.deprecated : '');
    warnings.push(`${name}@${version} is deprecated${reason ? ` (${reason})` : ''}${manifest.supersededBy ? `; superseded by ${manifest.supersededBy}` : ''}.`);
  }

  // Download the tarball.
  const tgz = await registryBytes(ctx, registry.url, registryPath(registry, 'versionTarball', { name, version }));

  // Integrity (SRI) check against the manifest's `integrity` field.
  const integrity = 'sha256-' + createHash('sha256').update(tgz).digest('base64');
  if (manifest?.integrity && manifest.integrity !== integrity) {
    throw new CliError(
      `Integrity mismatch for ${name}@${version}: manifest declares ${manifest.integrity} but tarball hashes to ${integrity}.`,
      1,
    );
  }

  let verifyResult = 'skipped';
  if (!options.noVerify) {
    verifyResult = registry.tree === 'v2'
      ? await verifyV2(ctx, registry, name, version, manifest, tgz)
      : await verifyV1(ctx, registry, name, version, manifest, tgz);
  }

  // Place under a local pack cache: <dir>/<name>/<version>/. Default dir is
  // ~/.openwop/packs (honors OPENWOP_CONFIG_HOME like the rest of the CLI).
  const baseDir = options.dir
    ? resolvePath(ctx.cwd, options.dir)
    : join(configHomeDir(ctx.env), 'packs');
  const destDir = join(baseDir, name, version);
  mkdirSync(destDir, { recursive: true });
  const tgzPath = join(destDir, `${version}.tgz`);
  const manifestPath = join(destDir, `${version}.json`);
  writeFileSync(tgzPath, tgz);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  for (const w of warnings) writeLine(ctx.io.stderr, `warning: ${w}`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, {
      name, version, tree: registry.tree, integrity, signature: verifyResult,
      yanked: Boolean(manifest?.yanked), deprecated: Boolean(manifest?.versionDeprecated || manifest?.deprecated),
      tarball: tgzPath, manifest: manifestPath,
    });
    return 0;
  }
  writeLine(ctx.io.stdout, `Installed ${name}@${version} (${registry.tree} tree)`);
  writeLine(ctx.io.stdout, `  signature: ${verifyResult}`);
  writeLine(ctx.io.stdout, `  integrity: ${integrity}`);
  writeLine(ctx.io.stdout, `  tarball:   ${tgzPath}`);
  return 0;
}

/**
 * v1 verification (unchanged from the v1 tree's conventions, mirroring
 * verify-signatures.mjs): method 'ed25519' signs the whole tarball; method
 * 'manual' signs the pack.json bytes inside the tarball.
 */
async function verifyV1(ctx: Ctx, registry: RegistryView, name: string, version: string, manifest: any, tgz: Buffer) {
  const keyId = manifest?.signing?.keyId ?? manifest?.signing?.publicKeyRef;
  if (!keyId) throw new CliError(`${name}@${version} manifest has no signing key reference; re-run with --no-verify to bypass.`, 1);
  const sig = await registryBytes(ctx, registry.url, registryPath(registry, 'versionSignature', { name, version }));
  if (sig.length !== 64) throw new CliError(`Signature for ${name}@${version} is ${sig.length} bytes; expected 64 for Ed25519.`, 1);
  const pubPem = (await registryBytes(ctx, registry.url, registryPath(registry, 'publicKey', { keyId }))).toString('utf8');
  const method = manifest?.signing?.method ?? 'ed25519';
  const signedBytes = method === 'manual' ? extractPackJsonBytes(tgz) : tgz;
  if (!ed25519Verify(null, signedBytes, createPublicKey(pubPem), sig)) {
    throw new CliError(`Signature verification FAILED for ${name}@${version} (keyId=${keyId}, method=${method}).`, 1);
  }
  return `verified (keyId=${keyId}, method=${method})`;
}

const V2_SCHEME = 'ed25519-canonical-json';

/**
 * v2 verification (spec/v2/core/packs.md §Signing): `signing` is exactly
 * `{ keyId, scheme: "ed25519-canonical-json" }`; the detached 64-byte Ed25519
 * signature covers the RFC 8785 (JCS) bytes of the pack.json inside the
 * tarball; the key is the registry's `signingKeys[]` entry for `keyId`, and its
 * `permittedNamespaces` MUST cover the pack name. A key whose `status` is not
 * `active` still verifies what it signed (a verifier MUST NOT refuse on it).
 */
async function verifyV2(ctx: Ctx, registry: RegistryView, name: string, version: string, manifest: any, tgz: Buffer) {
  const fail = (why: string) => new CliError(`Signature verification FAILED for ${name}@${version} (pack_signature_invalid): ${why}`, 1);
  const signing = manifest?.signing;
  if (!signing || typeof signing !== 'object') throw fail('the version manifest has no signing block; re-run with --no-verify to bypass.');
  const legacy = ['method', 'publicKeyRef', 'signatureRef'].filter((k) => k in signing);
  if (legacy.length > 0) throw fail(`a v2 signing block carries ${legacy.join(', ')} (v1 fields; a v2 block is { keyId, scheme }).`);
  if (signing.scheme !== V2_SCHEME) throw fail(`signing.scheme is ${JSON.stringify(signing.scheme)}; the only v2 scheme is ${V2_SCHEME}.`);
  const keyId = signing.keyId;
  if (typeof keyId !== 'string' || keyId === '') throw fail('signing.keyId is missing.');

  // The key and its namespace authority come from the registry's own discovery document.
  if (!registry.signingKeys) throw fail(`${registry.url} publishes no signingKeys[], so the namespace check cannot run.`);
  const key = registry.signingKeys.find((k: any) => k && k.keyId === keyId);
  if (!key) throw fail(`keyId ${keyId} is not listed in the registry's signingKeys[].`);
  const permitted: string[] = Array.isArray(key.permittedNamespaces) ? key.permittedNamespaces : [];
  if (!permitted.some((pattern) => namespaceCovers(pattern, name))) {
    throw fail(`key ${keyId} is not permitted to sign ${name} (permittedNamespaces: ${permitted.join(', ') || 'none'}).`);
  }

  // The signed document is the pack.json inside the tarball, and it must be the pack asked for.
  const packJson = extractPackJsonBytes(tgz);
  let embedded: any;
  try { embedded = JSON.parse(packJson.toString('utf8')); } catch { throw fail('the in-tarball pack.json is not JSON.'); }
  if (embedded?.name !== name || embedded?.version !== version) {
    throw fail(`the in-tarball pack.json is ${embedded?.name}@${embedded?.version}, not ${name}@${version}.`);
  }
  if (embedded?.signing?.keyId !== undefined && embedded.signing.keyId !== keyId) {
    throw fail(`the in-tarball pack.json names signer ${embedded.signing.keyId}, the version manifest ${keyId}.`);
  }
  if (canonicalJsonStringify(embedded) !== packJson.toString('utf8')) {
    throw fail('the in-tarball pack.json is not in canonical (RFC 8785) form, so its bytes are not what ed25519-canonical-json signs.');
  }

  const sig = await registryBytes(ctx, registry.url, registryPath(registry, 'versionSignature', { name, version }));
  if (sig.length !== 64) throw fail(`the signature is ${sig.length} bytes; expected 64 for Ed25519.`);
  const keyPath = typeof key.publicKeyUrl === 'string' && key.publicKeyUrl !== '' ? key.publicKeyUrl : registryPath(registry, 'publicKey', { keyId });
  const pubPem = (await registryBytes(ctx, registry.url, keyPath)).toString('utf8');
  if (!ed25519Verify(null, packJson, createPublicKey(pubPem), sig)) throw fail(`the signature does not verify under ${keyId}.`);
  const status = typeof key.status === 'string' ? key.status : 'active';
  return `verified (keyId=${keyId}, scheme=${V2_SCHEME}${status !== 'active' ? `, key status ${status}` : ''})`;
}

/**
 * Does a `permittedNamespaces` entry cover `name`? An entry is an exact pack
 * name or a `<prefix>.*` glob (the registry's own reading, openwop-registry
 * scripts/lib/namespace-authority.mjs); a bare prefix matches only itself.
 */
export function namespaceCovers(pattern: string, name: string): boolean {
  if (typeof pattern !== 'string') return false;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

// ── version resolution ───────────────────────────────────────────────────────

type SemVer = { major: number; minor: number; patch: number; pre: string[] };

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function isExactVersion(v: string): boolean {
  return SEMVER_RE.test(v.trim());
}

function parseSemver(v: string): SemVer | null {
  const m = SEMVER_RE.exec(String(v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** One comparator (`>=1.2.0`, `^1.2`, `~1.2.0`, `1.x`, `1.2.3`) as a predicate. */
function comparator(raw: string): (v: string) => boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!m) throw new CliError(`Unsupported version range "${raw}". Use an exact version, ^x.y.z, ~x.y.z, x.y.x, or comparators like ">=1.0.0 <2.0.0".`);
  const op = m[1] ?? '';
  const wild = (p: string | undefined) => p === undefined || /^[xX*]$/.test(p);
  const [maj, min, pat] = [m[2], m[3], m[4]];
  const n = (p: string | undefined) => (wild(p) ? 0 : Number(p));
  const floor = `${n(maj)}.${n(min)}.${n(pat)}${m[5] ?? ''}`;
  const cmp = (v: string) => compareSemver(v, floor);
  // Upper bound (exclusive) for a partial / caret / tilde form.
  let ceil: string | null = null;
  if (op === '^') {
    ceil = n(maj) > 0 || wild(min) ? `${n(maj) + 1}.0.0` : n(min) > 0 || wild(pat) ? `0.${n(min) + 1}.0` : `0.0.${n(pat) + 1}`;
  } else if (op === '~') {
    ceil = wild(min) ? `${n(maj) + 1}.0.0` : `${n(maj)}.${n(min) + 1}.0`;
  } else if (op === '' || op === '=') {
    if (wild(maj)) return () => true;
    if (wild(min)) ceil = `${n(maj) + 1}.0.0`;
    else if (wild(pat)) ceil = `${n(maj)}.${n(min) + 1}.0`;
    else return (v) => cmp(v) === 0;
  }
  if (ceil !== null) { const c = ceil; return (v) => cmp(v) >= 0 && compareSemver(v, `${c}-0`) < 0; }
  switch (op) {
    case '>=': return (v) => cmp(v) >= 0;
    case '>': return (v) => cmp(v) > 0;
    case '<=': return (v) => cmp(v) <= 0;
    default: return (v) => cmp(v) < 0;
  }
}

/** A semver range (`||`-separated sets of space-separated comparators). A prerelease matches only when asked for. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return range.split('||').some((set) => {
    const parts = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (parts.length === 0) return true;
    if (parsed.pre.length > 0 && !parts.some((p) => p.includes('-'))) return false;
    return parts.every((p) => comparator(p)(version));
  });
}

/**
 * The version `latest` or a range resolves to. Yanked versions are never
 * candidates (packs.md §"Version manifests": a range MUST skip them; the
 * index MUST NOT name one `latest` while an unyanked version exists — the
 * client re-checks rather than trusting that).
 */
export function resolveVersion(name: string, pack: any, range: string | undefined): string {
  const versions: any[] = Array.isArray(pack?.versions) ? pack.versions : [];
  const unyanked = versions.filter((v) => v && typeof v.version === 'string' && !v.yanked).map((v) => v.version as string);
  if (!range || range === 'latest') {
    const latest = typeof pack?.latest === 'string' ? pack.latest : undefined;
    const latestEntry = versions.find((v) => v?.version === latest);
    if (latest && versions.length === 0) return latest; // an index with no versions[] cannot say more
    if (latest && latestEntry && !latestEntry.yanked) return latest;
    const best = unyanked.filter((v) => (parseSemver(v)?.pre.length ?? 1) === 0).sort(compareSemver).pop() ?? unyanked.sort(compareSemver).pop();
    if (!best) throw new CliError(`${name} has no installable (unyanked) version; pin an exact version to install a yanked one.`, 1);
    return best;
  }
  const match = unyanked.filter((v) => satisfiesRange(v, range)).sort(compareSemver).pop();
  if (!match) {
    const yankedHit = versions.some((v) => v?.yanked && typeof v.version === 'string' && satisfiesRange(v.version, range));
    throw new CliError(`No unyanked version of ${name} satisfies "${range}"${yankedHit ? ' (a yanked version does; pin it exactly to install it)' : ''}.`, 1);
  }
  return match;
}

async function runPacksPublish(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--key', '--key-id', '--out', '--tree'],
  });
  if (options.help) {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  // The reference registry has NO write API (.well-known declares
  // writeApi.supported=false, publishMethod=github-pull-request). So
  // `publish` performs the LOCAL packaging + signing flow — producing the
  // signed tarball + sidecar artifacts that the publisher then commits and
  // opens a PR with (per registry/README.md §Publishing). This mirrors
  // scripts/build-pack-tarball.mjs's --signed path.
  const packDir = positionals[0];
  if (!packDir) throw new CliError('packs publish requires a pack directory.\nUsage: openwop packs publish <dir> --key <ed25519.pem> --key-id <id>');
  const absPackDir = resolvePath(ctx.cwd, packDir);
  const manifestPath = join(absPackDir, 'pack.json');
  if (!existsSync(manifestPath)) {
    throw new CliError(`No pack.json found in ${absPackDir}.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = manifest.name;
  const version = manifest.version;
  if (!name || !version) throw new CliError('pack.json must declare both "name" and "version".');

  const keyId = options.keyId ?? 'openwop-team-1';
  const tree = treeOption(options) ?? 'v2';
  // Augment the manifest with the signing block, then sign the CANONICAL
  // (RFC 8785) JSON — exactly the in-tarball pack.json bytes a verifier
  // checks. v2 (packs.md §Signing): the closed { keyId, scheme } block. The
  // frozen v1 tree keeps its { method: 'manual', publicKeyRef, signatureRef }.
  const signedManifest = {
    ...manifest,
    signing: tree === 'v2'
      ? { keyId, scheme: V2_SCHEME }
      : { method: 'manual', publicKeyRef: keyId, signatureRef: 'keys/pack.json.sig' },
  };
  const canonical = canonicalJsonStringify(signedManifest);

  // Load (or, for dev, generate) the Ed25519 private key.
  let privateKey;
  let ephemeralPublicB64: string | null = null;
  if (options.key) {
    privateKey = createPrivateKey({ key: readFileSync(resolvePath(ctx.cwd, options.key), 'utf8'), format: 'pem' });
  } else {
    // Convention: ~/.openwop-keys/<keyId>.private.pem (per project layout).
    const conventional = join(homedir(), '.openwop-keys', `${keyId}.private.pem`);
    if (existsSync(conventional)) {
      privateKey = createPrivateKey({ key: readFileSync(conventional, 'utf8'), format: 'pem' });
    } else {
      const kp = generateKeyPairSync('ed25519');
      privateKey = kp.privateKey;
      ephemeralPublicB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    }
  }
  const sig = ed25519Sign(null, Buffer.from(canonical, 'utf8'), privateKey);

  // Build the deterministic tarball: replace pack.json with the canonical
  // bytes + embed keys/pack.json.sig.
  const entries = walkPackDir(absPackDir)
    .filter((e) => e.name !== 'keys/pack.json.sig')
    .map((e) => (e.name === 'pack.json' ? { name: 'pack.json', content: Buffer.from(canonical, 'utf8') } : e));
  entries.push({ name: 'keys/pack.json.sig', content: sig });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tgz = buildUstarGzip(entries);
  const sha = createHash('sha256').update(tgz).digest('hex');

  const outDir = options.out ? resolvePath(ctx.cwd, options.out) : join(ctx.cwd, 'dist', 'packs');
  mkdirSync(outDir, { recursive: true });
  const base = `${name}-${version}`;
  const tgzPath = join(outDir, `${base}.tgz`);
  const sigPath = join(outDir, `${base}.sig`);
  const manifestOut = join(outDir, `${base}.manifest.json`);
  writeFileSync(tgzPath, tgz);
  writeFileSync(sigPath, sig);
  writeFileSync(manifestOut, JSON.stringify(signedManifest, null, 2) + '\n', 'utf8');

  if (ctx.json) {
    writeJson(ctx.io.stdout, {
      name, version, keyId, tree, integrity: `sha256:${sha}`,
      tarball: tgzPath, signature: sigPath, manifest: manifestOut,
      writeApi: false, publishMethod: 'github-pull-request',
      ephemeralPublicKey: ephemeralPublicB64 ?? undefined,
    });
    return 0;
  }
  writeLine(ctx.io.stdout, `Packaged + signed ${name}@${version} for the ${tree} tree (keyId=${keyId})`);
  writeLine(ctx.io.stdout, `  tarball:   ${tgzPath}`);
  writeLine(ctx.io.stdout, `  signature: ${sigPath}`);
  writeLine(ctx.io.stdout, `  manifest:  ${manifestOut}`);
  writeLine(ctx.io.stdout, `  integrity: sha256:${sha}`);
  if (ephemeralPublicB64) {
    writeLine(ctx.io.stdout, `  WARNING: no --key and no ~/.openwop-keys/${keyId}.private.pem — used an EPHEMERAL key.`);
    writeLine(ctx.io.stdout, `  Pre-register this public key (SPKI DER base64) with the registry before publishing:`);
    writeLine(ctx.io.stdout, `    ${ephemeralPublicB64}`);
  }
  writeLine(ctx.io.stdout, '');
  writeLine(ctx.io.stdout, 'The reference registry has no write API. To publish:');
  writeLine(ctx.io.stdout, `  1. Copy the artifacts into registry/${tree}/packs/${name}/-/ of an openwop-registry checkout`);
  writeLine(ctx.io.stdout, `  2. Run \`node registry/scripts/build-index.mjs --tree ${tree}\` to refresh the index.`);
  writeLine(ctx.io.stdout, '  3. Open a pull request (publishMethod: github-pull-request).');
  return 0;
}

async function runPacksYank(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--undo'],
    value: ['--version', '--tree'],
  });
  if (options.help) {
    write(ctx.io.stdout, PACKS_HELP);
    return 0;
  }
  // Yank is a registry-state change. The reference registry exposes no write
  // API (writeApi.supported=false), and lifecycle.yankSupported=true means it
  // is performed via PR: flip `"yanked": true` in the version manifest, then
  // rebuild the index. This subcommand applies that edit LOCALLY to a checked-
  // out registry tree so the change is ready to commit + PR.
  let name = positionals[0];
  let version = options.version;
  if (name && name.includes('@')) {
    const at = name.lastIndexOf('@');
    version = version ?? name.slice(at + 1);
    name = name.slice(0, at);
  }
  if (!name || !version) {
    throw new CliError('packs yank requires <name>@<version> (or <name> --version v).');
  }
  const root = requireRepoRoot(ctx);
  // New lifecycle changes land on the v2 tree (the v1 tree is frozen); --tree v1 for maintenance.
  const tree = treeOption(options) ?? 'v2';
  const manifestPath = join(root, 'registry', tree, 'packs', name, '-', `${version}.json`);
  if (!existsSync(manifestPath)) {
    throw new CliError(`Version manifest not found: ${manifestPath}\n(packs yank edits a local registry checkout; the published change lands via PR.)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const newValue = !options.undo;
  if (Boolean(manifest.yanked) === newValue) {
    writeLine(ctx.io.stdout, `${name}@${version} is already ${newValue ? 'yanked' : 'un-yanked'}; no change.`);
    return 0;
  }
  manifest.yanked = newValue;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (ctx.json) {
    writeJson(ctx.io.stdout, { name, version, tree, yanked: newValue, manifest: manifestPath, publishMethod: 'github-pull-request' });
    return 0;
  }
  writeLine(ctx.io.stdout, `${newValue ? 'Yanked' : 'Un-yanked'} ${name}@${version}`);
  writeLine(ctx.io.stdout, `  edited: ${manifestPath}`);
  writeLine(ctx.io.stdout, `  Next: run \`node registry/scripts/build-index.mjs --tree ${tree}\`, commit, and open a PR.`);
  return 0;
}

function canonicalJsonStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k: string) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k])).join(',') + '}';
}

function configHomeDir(env = process.env) {
  const base = env.OPENWOP_CONFIG_HOME ? env.OPENWOP_CONFIG_HOME : homedir();
  return join(base, '.openwop');
}

function extractPackJsonBytes(tarballBytes: any) {
  const decompressed = gunzipSync(tarballBytes);
  const BLOCK = 512;
  for (let off = 0; off + BLOCK <= decompressed.length; ) {
    const nameBuf = decompressed.subarray(off, off + 100);
    const nameEnd = nameBuf.indexOf(0);
    const name = nameBuf.subarray(0, nameEnd < 0 ? 100 : nameEnd).toString('utf8');
    if (!name) break;
    const sizeStr = decompressed.subarray(off + 124, off + 136).toString('ascii').replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = decompressed[off + 156];
    if (typeflag === 0x78 || typeflag === 0x4c) {
      throw new CliError('Tarball uses USTAR extended headers (entry names > 100 bytes); cannot verify pack.json signature.', 1);
    }
    if (name === 'pack.json' || name === './pack.json') {
      return decompressed.subarray(off + BLOCK, off + BLOCK + size);
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new CliError('pack.json not found in tarball.', 1);
}

function walkPackDir(packDir: any) {
  const ALLOWED_TOPS = new Set(['pack.json', 'README.md', 'LICENSE', 'index.mjs']);
  const ALLOWED_DIRS = new Set(['schemas', 'keys']);
  const entries: any[] = [];
  for (const entry of readdirSync(packDir).sort()) {
    const full = join(packDir, entry);
    const st = statSync(full);
    if (st.isFile()) {
      if (!ALLOWED_TOPS.has(entry)) continue;
      entries.push({ name: entry, content: readFileSync(full) });
    } else if (st.isDirectory() && ALLOWED_DIRS.has(entry)) {
      for (const f of readdirSync(full).sort()) {
        if (!f.endsWith('.json') && !f.endsWith('.pem') && !f.endsWith('.sig')) continue;
        entries.push({ name: `${entry}/${f}`, content: readFileSync(join(full, f)) });
      }
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

function buildUstarGzip(entries: any) {
  const ustarHeader = (name: any, size: any) => {
    const buf = Buffer.alloc(512, 0);
    const writeOctal = (n: any, len: any, offset: any) => {
      const s = n.toString(8).padStart(len - 1, '0') + '\0';
      buf.write(s, offset, len, 'ascii');
    };
    if (name.length > 100) throw new CliError(`Pack entry path too long for USTAR (>100 bytes): ${name}`, 1);
    buf.write(name, 0, 100, 'ascii');
    writeOctal(0o644, 8, 100);
    writeOctal(0, 8, 108);
    writeOctal(0, 8, 116);
    writeOctal(size, 12, 124);
    writeOctal(0, 12, 136);
    for (let i = 148; i < 156; i++) buf[i] = 0x20;
    buf[156] = 0x30;
    buf.write('ustar\0', 257, 6, 'ascii');
    buf.write('00', 263, 2, 'ascii');
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += buf[i];
    writeOctal(chksum, 8, 148);
    return buf;
  };
  const chunks: Uint8Array[] = [];
  for (const { name, content } of entries) {
    chunks.push(ustarHeader(name, content.length));
    chunks.push(content);
    const pad = 512 - (content.length % 512);
    if (pad !== 512) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
  gz[4] = 0; gz[5] = 0; gz[6] = 0; gz[7] = 0;
  gz[9] = 0xff;
  return gz;
}
