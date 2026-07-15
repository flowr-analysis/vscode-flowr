import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { getConfig, Settings } from './settings';
import { getBundledSigDbPath } from './extension';
import { readManifestFile, type SigDbManifest } from '@eagleoutice/flowr/project/sigdb/manifest';
import { sigDbCacheDir } from '@eagleoutice/flowr/project/sigdb/decompress';
import { selectDownloadVariants } from '@eagleoutice/flowr/project/sigdb/sigdb-download';
import { getSharedSigSource, type PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';

export const baseRPackages = new Set([
	'base', 'compiler', 'datasets', 'grDevices', 'graphics', 'grid', 'methods', 'parallel',
	'splines', 'stats', 'stats4', 'tcltk', 'tools', 'translations', 'utils'
]);

/** Whether the signature database is enabled via configuration */
export function isSigDbEnabled(): boolean {
	return getConfig().get<boolean>(Settings.SigDbEnabled, true);
}

/** Extra directory/bundle the user configured, searched in addition to the shipped default (maps to flowR's `solver.sigdb.additionalPaths`) */
export function getSigDbAdditionalPath(): string {
	return getConfig().get<string>(Settings.SigDbCustomPath, '');
}

/** Whether to automatically sync and download missing signature database shards */
export function shouldSigDbAutoSync(): boolean {
	return getConfig().get<boolean>(Settings.SigDbAutoSync, true);
}

/** Whether to load the signature database up front during startup */
export function shouldSigDbEagerlyLoad(): boolean {
	return getConfig().get<boolean>(Settings.SigDbEagerlyLoad, false);
}

/** the real, published-release "shard link" pointer: `{repo, tag, shards: {filename: {sha256, bytes}}}` */
export interface SigDbRemotePointer {
	format?: string;
	schema?: number;
	tag:     string;
	repo?:   string;
	shards:  Record<string, { sha256: string, bytes: number }>;
}

let cachedPointer: SigDbRemotePointer | undefined | null = null;

/**
 * Reads the sigdb release pointer shipped inside the extension bundle (`dist/node/sigdb/sigdb.remote.json`,
 * copied there by webpack from flowR's `data/sigdb`) directly off disk, relative to this extension's own
 * bundle location. We read it ourselves rather than calling flowR's `sigDbRemoteRelease()`/`syncedSigDbDir()`
 * because those resolve the pointer relative to `sigdb-download.js`'s *own* file location on disk (assuming a
 * normal `node_modules` layout) -- which breaks once that module is bundled into a single webpacked file.
 */
export function readSigDbRemotePointer(): SigDbRemotePointer | undefined {
	if(cachedPointer !== null) {
		return cachedPointer ?? undefined;
	}
	try {
		const bundled = getBundledSigDbPath();
		if(!bundled) {
			cachedPointer = undefined;
			return undefined;
		}
		const raw = fs.readFileSync(path.join(bundled, 'sigdb.remote.json'), 'utf8');
		cachedPointer = JSON.parse(raw) as SigDbRemotePointer;
	} catch{
		cachedPointer = undefined;
	}
	return cachedPointer ?? undefined;
}

/** the real cache directory flowR downloads/decompresses signature databases into (honors `$FLOWR_SIGDB_CACHE`/`$FLOWR_CACHE_DIR`/XDG) */
export function getSigDbCacheDir(): string {
	return sigDbCacheDir();
}

/** the directory a sync of the bundled pointer's release lands in / has already landed in -- no network access */
export function getSigDbBundleDir(): string | undefined {
	const pointer = readSigDbRemotePointer();
	if(!pointer) {
		return undefined;
	}
	return path.join(sigDbCacheDir(), 'bundles', pointer.tag);
}

const ManifestVariants = ['.zst', '.br', ''];

/** locate a real, on-disk manifest file for a scope (`base` | `current` | `history`) inside a directory */
function findManifestFile(dir: string, scope: string): string | undefined {
	for(const ext of ManifestVariants) {
		const candidate = path.join(dir, `${scope}.manifest.json${ext}`);
		if(fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export interface SigDbScopeState {
	scope:         'base' | 'current' | 'history';
	manifestPath?: string;
	manifest?:     SigDbManifest;
}

/**
 * Real, on-disk manifest state for one scope, searched across the bundled sigdb dir, the user's configured
 * additional path, and the downloaded-bundle dir (in that order, first match wins) -- mirrors the search
 * order flowR's own sigdb plugin uses (bundled default, then `additionalPaths`/`$FLOWR_SIGDB`).
 */
export function getSigDbScopeState(scope: 'base' | 'current' | 'history'): SigDbScopeState {
	const dirs = [getBundledSigDbPath(), getSigDbAdditionalPath().trim() || undefined, getSigDbBundleDir()]
		.filter((d): d is string => !!d);

	for(const dir of dirs) {
		const manifestPath = findManifestFile(dir, scope);
		if(!manifestPath) {
			continue;
		}
		try {
			return { scope, manifestPath, manifest: readManifestFile(manifestPath) };
		} catch{
			// fall through to the next search dir
		}
	}
	return { scope };
}

/**
 * Opens a package-signature source, tolerating a corrupt or partially-downloaded shard (e.g. from a network
 * connection cut mid-download by a sandbox) instead of throwing -- callers get `undefined` and an explanation
 * via `onError`/the output channel rather than an unhandled rejection breaking the tree view or hover.
 */
export async function safeGetSigSource(manifestPath: string, onError?: (message: string) => void): Promise<PackageSignatureSource | undefined> {
	try {
		return await getSharedSigSource(manifestPath);
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		onError?.(`could not open ${manifestPath}: ${message}`);
		return undefined;
	}
}

/** sha256 hex digest of a file's contents (same algorithm flowR's own downloader hashes against) */
function sha256File(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * how long to wait for a connection/response before giving up -- a sandbox that silently drops egress (rather
 *  than refusing the connection) would otherwise hang the request forever with no feedback to the user
 */
const RequestTimeoutMs = 30_000;

/**
 * GET following redirects (GitHub release assets redirect to a signed storage host); resolves the final
 * response for streaming. VS Code patches Node's `https` module in the extension host to honor the user's
 * `http.proxy`/`http.systemCertificates` settings automatically, so this needs no proxy handling of its own.
 */
function httpGet(url: string, opts: { redirects?: number, signal?: AbortSignal } = {}): Promise<import('http').IncomingMessage> {
	const { redirects = 5, signal } = opts;
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': 'vscode-flowr', Accept: 'application/octet-stream' },
			timeout: RequestTimeoutMs,
			signal
		}, res => {
			const status = res.statusCode ?? 0;
			if(status >= 300 && status < 400 && res.headers.location && redirects > 0) {
				res.resume();
				httpGet(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, signal }).then(resolve, reject);
			} else if(status >= 200 && status < 300) {
				resolve(res);
			} else {
				res.resume();
				reject(new Error(`GET ${url} -> HTTP ${status}`));
			}
		});
		req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${RequestTimeoutMs / 1000}s (network may be blocked by a sandbox)`)));
		req.on('error', reject);
	});
}

async function downloadTo(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	const res = await httpGet(url, { signal });
	await new Promise<void>((resolve, reject) => {
		const out = fs.createWriteStream(dest);
		res.on('error', reject);
		out.on('error', reject).on('finish', () => out.close(err => err ? reject(err) : resolve()));
		res.pipe(out);
	});
}

export interface SigDbScopeDownloadResult {
	dir:   string;
	files: string[];
}

/**
 * a real, on-disk shard id within a scope's manifest, e.g. `current-top`, `base-full`, `history-rest` - parsed
 *  from the release pointer's own asset names (`<scope>.<shardId>.sigs.ndjson[.br|.zst]`)
 */
function shardIdOf(scope: string, assetName: string): string {
	const rest = assetName.slice(scope.length + 1);
	// `rest` is `manifest.json[.br|.zst]` for the manifest itself - no leading dot before "manifest" to strip,
	// unlike a data shard's `<id>.sigs.ndjson[.br|.zst]`, so it needs its own (anchored) check
	if(/^manifest\.json(\.br|\.zst)?$/.test(rest)) {
		return 'manifest';
	}
	return rest.replace(/\.sigs\.ndjson(\.br|\.zst)?$/, '');
}

/** named, incrementally-downloadable groups of shards per scope, real IDs matching the pointer's own asset names */
export const SigDbShardGroups: Record<'base' | 'current' | 'history', { id: string, label: string, shardIds: string[] }[]> = {
	base: [
		{ id: 'current', label: 'Base R (current version only)', shardIds: ['base-current'] },
		{ id: 'full', label: 'Base R (all historical versions)', shardIds: ['base-current', 'base-full'] }
	],
	current: [
		{ id: 'top', label: 'Top CRAN packages only (fast)', shardIds: ['base-current', 'current-top'] },
		{ id: 'full', label: 'All current CRAN packages', shardIds: ['base-current', 'base-full', 'current-top', 'current-rest'] }
	],
	history: [
		{ id: 'full', label: 'Full CRAN history', shardIds: ['history-rest'] }
	]
};

/**
 * Downloads a scope's shards (`base` | `current` | `history`) from the bundled release pointer, optionally
 * restricted to a subset of shard ids (see {@link SigDbShardGroups} - e.g. `['current-top']` alone, skipping
 * the long-tail `current-rest` shard). The manifest and any shared dictionary shards are always included
 * regardless of the filter, since a data shard is unreadable without them. Already-present, hash-verified
 * shards are skipped - flowR's own `downloadFullSigDb` has no such per-shard filter (it always fetches
 * everything), so this mirrors its exact GET/redirect/hash-verify logic
 * (see `@eagleoutice/flowr/project/sigdb/sigdb-download.js`) filtered down manually.
 */
export async function downloadSigDbScope(
	scope: 'base' | 'current' | 'history',
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
	shardIds?: readonly string[]
): Promise<SigDbScopeDownloadResult> {
	const pointer = readSigDbRemotePointer();
	if(!pointer) {
		throw new Error('no signature database release pointer is bundled with this build of the extension');
	}
	const dir = path.join(sigDbCacheDir(), 'bundles', pointer.tag);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`cannot create the signature database cache directory (${dir}): ${message}. If this environment is sandboxed, set vscode-flowr's FLOWR_SIGDB_CACHE/FLOWR_CACHE_DIR env var to a writable path.`);
	}

	const scopeShardNames = Object.keys(pointer.shards).filter(name => name.startsWith(`${scope}.`));
	const wantedNames = shardIds === undefined
		? scopeShardNames
		: scopeShardNames.filter(name => {
			const id = shardIdOf(scope, name);
			return id === 'manifest' || id === 'dict' || shardIds.includes(id);
		});
	const picked = selectDownloadVariants(wantedNames);
	onProgress?.(`syncing ${picked.length} shard${picked.length === 1 ? '' : 's'} for ${scope} (${pointer.tag}) from ${pointer.repo}`);

	const files: string[] = [];
	for(const name of picked) {
		if(signal?.aborted) {
			throw new Error('download cancelled');
		}
		const meta = pointer.shards[name];
		const dest = path.join(dir, name);
		if(fs.existsSync(dest) && sha256File(dest) === meta.sha256) {
			onProgress?.(`have ${name}`);
		} else {
			onProgress?.(`downloading ${name} (${(meta.bytes / 1e6).toFixed(1)} MB)`);

			await downloadTo(`https://github.com/${pointer.repo}/releases/download/${pointer.tag}/${encodeURIComponent(name)}`, dest, signal);
			if(sha256File(dest) !== meta.sha256) {
				throw new Error(`sha256 mismatch for ${name} (${pointer.tag}); the download is corrupt, retry`);
			}
		}
		files.push(dest);
	}
	return { dir, files };
}

/** the real, individual shard ids (`current-top`, `base-full`, ...) actually present and hash-verified on disk for a scope */
export function getDownloadedShardIds(scope: 'base' | 'current' | 'history'): Set<string> {
	const pointer = readSigDbRemotePointer();
	const dir = getSigDbBundleDir();
	if(!pointer || !dir) {
		return new Set();
	}
	const scopeShardNames = Object.keys(pointer.shards).filter(name => name.startsWith(`${scope}.`));
	return new Set(
		selectDownloadVariants(scopeShardNames).filter(name => {
			const dest = path.join(dir, name);
			return fs.existsSync(dest) && sha256File(dest) === pointer.shards[name].sha256;
		}).map(name => shardIdOf(scope, name))
	);
}

/** which of a scope's shard groups are already fully downloaded (hash-verified) on disk */
export function getDownloadedShardGroups(scope: 'base' | 'current' | 'history'): Set<string> {
	const downloaded = getDownloadedShardIds(scope);
	const groups = new Set<string>();
	for(const group of SigDbShardGroups[scope]) {
		if(group.shardIds.every(id => downloaded.has(id))) {
			groups.add(group.id);
		}
	}
	return groups;
}

/**
 * Deletes one scope's downloaded shard files (and any decompressed working-cache copies keyed by their
 * content hash) from the synced bundle directory. The bundled release pointer + remote release itself are
 * untouched, so the scope can be re-downloaded later.
 */
/**
 * Removes a scope's downloaded shard files. With `shardIds` given, only those specific data shards are removed
 * (the manifest and shared dictionary are left in place, since other still-downloaded shard groups need them);
 * omit it to remove the whole scope, including the manifest, dictionary, and decompressed working-cache copies.
 */
export function removeSigDbScope(scope: 'base' | 'current' | 'history', shardIds?: readonly string[]): { removed: string[] } {
	const removed: string[] = [];
	const pointer = readSigDbRemotePointer();
	const dir = getSigDbBundleDir();
	const state = getSigDbScopeState(scope);

	// the decompressed working-cache copy for each shard this scope's manifest describes, keyed by content hash
	// (only cleaned up on a full-scope removal - a partial removal may leave other shards depending on it)
	if(shardIds === undefined && state.manifest) {
		for(const shard of state.manifest.shards) {
			const cached = path.join(sigDbCacheDir(), `sigdb-${shard.hash}.sigs.ndjson`);
			if(fs.existsSync(cached)) {
				fs.unlinkSync(cached);
				removed.push(cached);
			}
		}
	}

	if(pointer && dir) {
		for(const name of Object.keys(pointer.shards).filter(n => n.startsWith(`${scope}.`))) {
			if(shardIds !== undefined) {
				const id = shardIdOf(scope, name);
				if(id === 'manifest' || id === 'dict' || !shardIds.includes(id)) {
					continue;
				}
			}
			const file = path.join(dir, name);
			if(fs.existsSync(file)) {
				fs.unlinkSync(file);
				removed.push(file);
			}
		}
	}

	return { removed };
}

/** same URL scheme as flowR's own `signature` query (`queries/catalog/signature-query/signature-query-executor.js`) */
const CranGithubMirror = 'https://github.com/cran';
const RdrrTopicName = /^[A-Za-z.][A-Za-z0-9._]*$/;

/** the CRAN package landing page (only meaningful for CRAN packages - base R packages are not published under `package=`, there is no such CRAN page for them) */
export function cranPageUrl(pkg: string): string {
	return `https://cran.r-project.org/package=${encodeURIComponent(pkg)}`;
}

/** the CRAN listing page for an R major-version series (e.g. `R-4`) - what to link a base-R package's version to instead of a (non-existent) CRAN package page */
export function rMajorVersionPageUrl(version: string): string | undefined {
	const major = /^(\d+)\./.exec(version)?.[1];
	return major ? `https://cran.r-project.org/src/base/R-${major}/` : undefined;
}

/** deep-link a function definition into the CRAN mirror (`github.com/cran/<pkg>`) at the package's version tag */
export function cranMirrorSourceUrl(pkg: string, version: string | undefined, file: string, line: number | undefined): string {
	const ref = version ? encodeURIComponent(version) : 'HEAD';
	const anchor = line !== undefined && line >= 0 ? `#L${line}` : '';
	return `${CranGithubMirror}/${encodeURIComponent(pkg)}/blob/${ref}/${file}${anchor}`;
}

/** best-effort rdrr.io documentation link: `/r/<pkg>/<fn>` for base R, `/cran/<pkg>/man/<fn>` for CRAN */
export function rdrrDocUrl(pkg: string, fn: string, opts: { base: boolean, cran: boolean }): string | undefined {
	if(!RdrrTopicName.test(fn)) {
		return undefined;
	}
	if(opts.base) {
		return `https://rdrr.io/r/${pkg}/${fn}.html`;
	}
	if(opts.cran) {
		return `https://rdrr.io/cran/${pkg}/man/${fn}.html`;
	}
	return undefined;
}

const SigDbScopeOrder = ['base', 'current', 'history'] as const;

/** the first downloaded scope (base, then current, then history) that knows `pkg`, and its opened source */
export async function findSigDbPackageSource(pkg: string): Promise<{ scope: 'base' | 'current' | 'history', source: PackageSignatureSource } | undefined> {
	for(const scope of SigDbScopeOrder) {
		const state = getSigDbScopeState(scope);
		if(!state.manifestPath) {
			continue;
		}
		const source = await safeGetSigSource(state.manifestPath);
		if(source?.has(pkg)) {
			return { scope, source };
		}
	}
	return undefined;
}

/** the signature database's recorded (latest) version for `pkg`, if any downloaded scope knows it */
export async function resolveSigDbPackageVersion(pkg: string): Promise<string | undefined> {
	const found = await findSigDbPackageSource(pkg);
	return found?.source.latestVersion(pkg)?.str;
}

/**
 * Whether `fnName` looks like an S3 generic within `pkg`: other exported functions in the same package/version
 * dispatch off it (`<fnName>.<class>`, e.g. `print` is a generic because `print.data.frame` exists). Same
 * heuristic flowR's own `signature` query uses (`reconstructS3Generics` in the sigdb plugin), computed directly
 * here since that helper isn't exported and needs a live analyzer to reach otherwise.
 */
export function isSigDbFunctionS3Generic(source: PackageSignatureSource, pkg: string, fnName: string, version: string | undefined): boolean {
	const prefix = `${fnName}.`;
	return (source.functions(pkg, version) ?? []).some(f => f.exported && f.name !== fnName && f.name.startsWith(prefix));
}

/**
 * The non-overlapping set of manifest *file* paths (not directories) to mount for `additionalPaths`/
 * `FLOWR_SIGDB`. `current`'s manifest already embeds its own copy of the base-R shards (so it is
 * self-sufficient for base R + current CRAN on its own), whereas `base`'s manifest describes the *same*
 * base packages again - mounting both at once registers every base package twice and crashes flowR's own
 * `reconstructS3Generics` deep inside dependency resolution. So: prefer `current` over `base` (never both),
 * and always add `history` too (it does not re-embed base, so it is safe to combine with either).
 */
export function getSigDbMountPaths(): string[] {
	const current = getSigDbScopeState('current');
	const base = getSigDbScopeState('base');
	const history = getSigDbScopeState('history');
	const paths: string[] = [];
	if(current.manifestPath) {
		paths.push(current.manifestPath);
	} else if(base.manifestPath) {
		paths.push(base.manifestPath);
	}
	if(history.manifestPath) {
		paths.push(history.manifestPath);
	}
	return paths;
}

/** A short, human-readable summary of the active signature database, built from real on-disk manifest state */
export function sigDbSummary(): string {
	if(!isSigDbEnabled()) {
		return 'Signature DB: disabled';
	}
	const scopes: string[] = [];
	for(const scope of ['base', 'current', 'history'] as const) {
		if(getSigDbScopeState(scope).manifest) {
			scopes.push(scope);
		}
	}
	return scopes.length > 0 ? `Signature DB: ${scopes.join(', ')}` : 'Signature DB: not yet downloaded';
}
