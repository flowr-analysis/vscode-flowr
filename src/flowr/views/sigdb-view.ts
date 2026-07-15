import * as vscode from 'vscode';
import {
	isSigDbEnabled, getSigDbAdditionalPath, getSigDbCacheDir, getSigDbBundleDir,
	readSigDbRemotePointer, getSigDbScopeState, safeGetSigSource,
	downloadSigDbScope, removeSigDbScope, cranMirrorSourceUrl, cranPageUrl, rMajorVersionPageUrl, rdrrDocUrl, isSigDbFunctionS3Generic,
	SigDbShardGroups, getDownloadedShardGroups, getDownloadedShardIds
} from '../../package-db';
import { Settings, getConfig } from '../../settings';
import { registerCommand, isWeb, refreshSigDbConfig } from '../../extension';
import { downloadFullSigDb } from '@eagleoutice/flowr/project/sigdb/sigdb-download';
import type { PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';
import type { SigParameter } from '@eagleoutice/flowr/project/sigdb/decode';
import { RRange, RVersion } from '@eagleoutice/flowr/util/r-version';

const GlobChars = /[*?]/;

/** `*`/`?` glob to an anchored, case-sensitive RegExp (same semantics as flowR's own `signature` query) */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`);
}

/** matches a package/function name against an exact string or a `*`/`?` glob pattern */
export function matchesPattern(pattern: string, value: string): boolean {
	return GlobChars.test(pattern) ? globToRegExp(pattern).test(value) : pattern === value;
}

/** a version pattern: exact string, a glob (`3.*`), or a semver-ish range (`>=3.0.0`) - via flowR's real `RVersion`/`RRange` */
export function matchesVersion(pattern: string, version: string): boolean {
	if(pattern === version) {
		return true;
	}
	if(GlobChars.test(pattern)) {
		return matchesPattern(pattern, version);
	}
	const range = RRange.parse(pattern);
	return range ? RRange.satisfies(version, range) : false;
}

function formatSignature(params: readonly SigParameter[]): string {
	return params.map(p => {
		let s = p.name;
		if(p.default !== undefined) {
			s += ` = ${p.default}`;
		} else if(p.optional) {
			s += '?';
		}
		return s;
	}).join(', ');
}

export const FlowrSigDbViewId = 'flowr-sigdb';

const Scopes = ['base', 'current', 'history'] as const;
type Scope = typeof Scopes[number];

const ScopeLabel: Record<Scope, string> = {
	base:    'Base R',
	current: 'Current CRAN',
	history: 'Full CRAN History'
};

const ScopeDescription: Record<Scope, string> = {
	base:    'R-core packages (downloaded on sync, not bundled with the extension)',
	current: 'Latest version of every current CRAN package (downloading fetches all of its shards together)',
	history: 'Full CRAN archive, including every historical version of every package'
};

/** how many children to materialize at once (packages under a scope, functions under a version) before capping */
const MaxListedChildren = 200;

export type SigDbNode =
	| { kind: 'scope', scope: Scope }
	| { kind: 'sync', scope: Scope }
	| { kind: 'package', scope: Scope, pkg: string }
	| { kind: 'version', scope: Scope, pkg: string, version: string }
	| { kind: 'function', scope: Scope, pkg: string, version: string, name: string }
	/**
	 * the next page of a scope's package list (`pkg` unset) or a version's function list (`pkg` set) - itself
	 *  lazily expandable, so a huge listing paginates instead of dead-ending in a static "N more"
	 */
	| { kind: 'more', scope: Scope, pkg?: string, version?: string, offset: number, remaining: number }
	| { kind: 'custom', path: string }
	| { kind: 'info', text: string };

function nodeId(node: SigDbNode): string {
	switch(node.kind) {
		case 'scope': return `scope:${node.scope}`;
		case 'sync': return `sync:${node.scope}`;
		case 'package': return `pkg:${node.scope}:${node.pkg}`;
		case 'version': return `ver:${node.scope}:${node.pkg}:${node.version}`;
		case 'function': return `fn:${node.scope}:${node.pkg}:${node.version}:${node.name}`;
		case 'more': return node.pkg !== undefined
			? `more:fn:${node.scope}:${node.pkg}:${node.version}:${node.offset}`
			: `more:pkg:${node.scope}:${node.offset}`;
		case 'custom': return `custom:${node.path}`;
		case 'info': return `info:${node.text}`;
	}
}

/** Tree view over the real, on-disk signature-database state, built lazily (nothing is enumerated until expanded) */
/** exported for testing - see sigdb-search.test.ts's partial-download tree resilience test */
export class SigDbTreeDataProvider implements vscode.TreeDataProvider<SigDbNode> {
	private changeEvent = new vscode.EventEmitter<SigDbNode | undefined>();
	public readonly onDidChangeTreeData = this.changeEvent.event;
	/** ids that must stay reachable via getChildren() even past the listing cap -- see {@link pin} */
	private readonly pinned = new Set<string>();

	constructor(private output: vscode.OutputChannel) {}

	/** guarantees `id` survives {@link capped} truncation, so `TreeView.reveal()` can find it even deep in an alphabetical listing */
	pin(id: string): void {
		this.pinned.add(id);
	}

	dispose(): void {
		this.changeEvent.dispose();
	}

	refresh(): void {
		this.changeEvent.fire(undefined);
	}

	getParent(node: SigDbNode): SigDbNode | undefined {
		switch(node.kind) {
			case 'sync': return { kind: 'scope', scope: node.scope };
			case 'package': return { kind: 'scope', scope: node.scope };
			case 'version': return { kind: 'package', scope: node.scope, pkg: node.pkg };
			case 'function': return { kind: 'version', scope: node.scope, pkg: node.pkg, version: node.version };
			case 'more': return node.pkg !== undefined
				? { kind: 'version', scope: node.scope, pkg: node.pkg, version: node.version ?? '' }
				: { kind: 'scope', scope: node.scope };
			default: return undefined;
		}
	}

	async getChildren(element?: SigDbNode): Promise<SigDbNode[]> {
		if(!element) {
			return this.getRootChildren();
		}
		switch(element.kind) {
			case 'scope': return this.getScopeChildren(element.scope);
			case 'package': return this.getPackageChildren(element.scope, element.pkg);
			case 'version': return this.getVersionChildren(element.scope, element.pkg, element.version);
			case 'more': return element.pkg !== undefined
				? this.getVersionChildren(element.scope, element.pkg, element.version, element.offset)
				: this.getScopeChildren(element.scope, element.offset);
			default: return [];
		}
	}

	private getRootChildren(): SigDbNode[] {
		if(isWeb()) {
			return [{ kind: 'info', text: 'Signature databases require local file/network access and are not available in the web extension.' }];
		}
		if(!isSigDbEnabled()) {
			return [{ kind: 'info', text: 'Signature database is disabled (vscode-flowr.config.solver.sigdb.enabled).' }];
		}

		const children: SigDbNode[] = Scopes.map(scope => ({ kind: 'scope', scope }));
		const custom = getSigDbAdditionalPath().trim();
		// a customPath equal to the auto-managed synced-bundle dir isn't something the user configured - it is
		// stale state from an earlier bug where syncing wrote its destination there; self-heal it away
		if(custom && custom === getSigDbBundleDir()) {
			void getConfig().update(Settings.SigDbCustomPath, '', vscode.ConfigurationTarget.Global);
		} else if(custom) {
			children.push({ kind: 'custom', path: custom });
		}
		return children;
	}

	private async openScopeSource(scope: Scope): Promise<PackageSignatureSource | undefined> {
		const state = getSigDbScopeState(scope);
		if(!state.manifestPath) {
			return undefined;
		}
		return safeGetSigSource(state.manifestPath, msg => this.output.appendLine(`[SigDB] ${msg}`));
	}

	private async getScopeChildren(scope: Scope, offset = 0): Promise<SigDbNode[]> {
		const state = getSigDbScopeState(scope);
		if(!state.manifest || !state.manifestPath) {
			return [{ kind: 'sync', scope }];
		}
		const source = await this.openScopeSource(scope);
		if(!source) {
			return [{ kind: 'info', text: 'Could not open this database (see the flowR output channel).' }];
		}
		// `current`/`history` manifests embed their own base-R shard copy (so each scope is self-contained and
		// can resolve base R symbols on its own) -- hide that overlap here since "Base R" already lists them,
		// rather than showing every base package duplicated under every scope.
		let names = [...source.packageNames()];
		if(scope !== 'base') {
			names = names.filter(pkg => !source.isBaseR(pkg));
		}
		names.sort((a, b) => a.localeCompare(b));
		const packages = this.capped(
			names.map(pkg => ({ kind: 'package', scope, pkg } as SigDbNode)),
			offset,
			nextOffset => ({ kind: 'more', scope, offset: nextOffset, remaining: names.length - nextOffset })
		);
		// the manifest lists every package in the scope regardless of which shard groups are actually on disk
		// (e.g. a "top only" download still lists the long-tail packages, just without their function data) -
		// so keep a way to fetch the rest visible at the top at all times, not just before the first download
		const mostComplete = SigDbShardGroups[scope].at(-1);
		if(offset === 0 && mostComplete && !getDownloadedShardGroups(scope).has(mostComplete.id)) {
			return [{ kind: 'sync', scope }, ...packages];
		}
		return packages;
	}

	/** an explanatory leaf shown instead of a package's versions/functions when its shard isn't actually on disk yet */
	private notYetDownloadedNode(scope: Scope, e: unknown): SigDbNode {
		this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		return {
			kind: 'info',
			text: `Not downloaded yet - this package's data lives in a shard of ${ScopeLabel[scope]} you haven't synced. Use the download icon on ${ScopeLabel[scope]} to fetch the rest.`
		};
	}

	private async getPackageChildren(scope: Scope, pkg: string): Promise<SigDbNode[]> {
		const source = await this.openScopeSource(scope);
		if(!source) {
			return [];
		}
		try {
			const releases = source.releaseDates(pkg);
			if(releases.length > 0) {
				return releases.slice().reverse().map(r => ({ kind: 'version', scope, pkg, version: r.version.str } as SigDbNode));
			}
			// base R packages don't carry release dates the way CRAN packages do - their per-R-release version
			// history lives in `coreVersions` instead (e.g. `compiler` has one entry per R release since 2.13.0)
			if(source.isBaseR(pkg)) {
				const core = source.coreVersions(pkg) ?? [];
				if(core.length > 0) {
					return core.slice().reverse().map(v => ({ kind: 'version', scope, pkg, version: v.str } as SigDbNode));
				}
			}
			const latest = source.latestVersion(pkg);
			if(latest) {
				return [{ kind: 'version', scope, pkg, version: latest.str }];
			}
			// no version metadata at all -- fall back to functions directly under the package, unversioned
			return await this.getVersionChildren(scope, pkg, undefined);
		} catch(e) {
			return [this.notYetDownloadedNode(scope, e)];
		}
	}

	private async getVersionChildren(scope: Scope, pkg: string, version: string | undefined, offset = 0): Promise<SigDbNode[]> {
		const source = await this.openScopeSource(scope);
		try {
			const functions = source?.functions(pkg, version) ?? [];
			const names = functions.map(f => f.name).sort((a, b) => a.localeCompare(b));
			return this.capped(
				names.map(name => ({ kind: 'function', scope, pkg, version: version ?? '', name } as SigDbNode)),
				offset,
				nextOffset => ({ kind: 'more', scope, pkg, version, offset: nextOffset, remaining: names.length - nextOffset })
			);
		} catch(e) {
			return [this.notYetDownloadedNode(scope, e)];
		}
	}

	/**
	 * slices `nodes` at `offset`, appending a lazily-expandable "more" node (built by `buildMore`) for the next
	 *  page when there's more beyond the listing cap - so a huge list paginates instead of dead-ending
	 */
	private capped(nodes: SigDbNode[], offset: number, buildMore: (nextOffset: number) => SigDbNode): SigDbNode[] {
		const remainingNodes = nodes.slice(offset);
		if(remainingNodes.length <= MaxListedChildren) {
			return remainingNodes;
		}
		const visible = remainingNodes.slice(0, MaxListedChildren);
		const overflow = remainingNodes.slice(MaxListedChildren);
		// anything pinned (e.g. a search result being revealed) stays reachable on this page too
		const pinnedOverflow = overflow.filter(n => this.pinned.has(nodeId(n)));
		const nextOffset = offset + MaxListedChildren;
		return [...visible, ...pinnedOverflow, buildMore(nextOffset)];
	}

	/**
	 * for Base R, the R-core version range a package was actually bundled for, when it doesn't span the whole
	 * known history - `from R vX` if added later, `until R vY` if since removed, both if it was only ever
	 * bundled for a middle stretch of R releases
	 */
	private baseRCoreRangeLabel(source: PackageSignatureSource, pkg: string): string | undefined {
		const core = source.coreVersions(pkg);
		const allCore = source.coreVersions('base');
		const firstCore = core?.[0];
		const lastCore = core?.at(-1);
		const earliestR = allCore?.[0];
		const latestR = allCore?.at(-1);
		if(!firstCore || !lastCore || !earliestR || !latestR) {
			return undefined;
		}
		const addedLater = RVersion.compare(firstCore.str, earliestR.str) > 0;
		const removedSince = RVersion.compare(lastCore.str, latestR.str) < 0;
		if(addedLater && removedSince) {
			return `R v${firstCore.str}–v${lastCore.str}`;
		} else if(addedLater) {
			return `from R v${firstCore.str}`;
		} else if(removedSince) {
			return `until R v${lastCore.str}`;
		}
		return undefined;
	}

	/**
	 * rich tooltip for a package-level node: version, export/deprecation counts, CRAN/base-R attribution and
	 * links - the same information a hover in the editor would show for a use of this package. Everything here
	 * beyond the package name can need a shard's actual data (not just the manifest's package index), which may
	 * not be on disk yet for a partially-downloaded scope - degrade to the bare item rather than throw.
	 */
	private async packageTreeItem(scope: Scope, pkg: string): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(pkg, vscode.TreeItemCollapsibleState.Collapsed);
		const source = await this.openScopeSource(scope);
		if(!source) {
			return item;
		}
		try {
			const version = source.latestVersion(pkg)?.str;
			const exportsInfo = source.lookup(pkg, version);
			const base = source.isBaseR(pkg);
			// base R packages are not published under CRAN's `package=` landing pages - link to the R version
			// series they shipped with instead (both link targets are real, existing CRAN pages)
			const cranPage = !base && exportsInfo?.cran ? cranPageUrl(pkg) : undefined;
			const rVersionPage = base && version ? rMajorVersionPageUrl(version) : undefined;
			const link = cranPage ?? rVersionPage;
			const coreRange = base ? this.baseRCoreRangeLabel(source, pkg) : undefined;
			const versionCount = base ? undefined : source.releaseDates(pkg).length;
			item.description = coreRange ?? (versionCount && versionCount > 1 ? `${versionCount} versions` : undefined);

			const md = new vscode.MarkdownString();
			md.appendMarkdown(link ? `**[\`${pkg}\`](${link})**` : `**\`${pkg}\`**`);
			if(version) {
				md.appendMarkdown(` \`v${version}\``);
			}
			md.appendMarkdown('\n\n');
			md.appendMarkdown(base ? 'Part of base R.' : (exportsInfo?.cran ? 'A CRAN package.' : 'Not a CRAN package.'));
			if(coreRange) {
				md.appendMarkdown(` ${coreRange}.`);
			} else if(versionCount && versionCount > 1) {
				md.appendMarkdown(` ${versionCount} versions known.`);
			}
			if(exportsInfo) {
				md.appendMarkdown(`\n\n${exportsInfo.exported.length} exported identifiers`);
				if(exportsInfo.deprecated.length > 0) {
					md.appendMarkdown(`, ${exportsInfo.deprecated.length} deprecated`);
				}
			}
			if(cranPage) {
				md.appendMarkdown(`\n\n[CRAN](${cranPage})`);
			} else if(rVersionPage) {
				md.appendMarkdown(`\n\n[R v${version} source](${rVersionPage})`);
			}
			md.isTrusted = true;
			item.tooltip = md;
		} catch(e) {
			this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		}
		return item;
	}

	async getTreeItem(node: SigDbNode): Promise<vscode.TreeItem> {
		const item = await this.buildTreeItem(node);
		item.id = nodeId(node);
		return item;
	}

	private async buildTreeItem(node: SigDbNode): Promise<vscode.TreeItem> {
		switch(node.kind) {
			case 'scope': return this.scopeTreeItem(node.scope);
			case 'sync': return this.syncTreeItem(node.scope);
			case 'package': return this.packageTreeItem(node.scope, node.pkg);
			case 'version': return this.versionTreeItem(node.scope, node.pkg, node.version);
			case 'function': return this.functionTreeItem(node);
			case 'more': {
				const item = new vscode.TreeItem(`… ${node.remaining} more`, vscode.TreeItemCollapsibleState.Collapsed);
				item.iconPath = new vscode.ThemeIcon('ellipsis');
				item.tooltip = 'Expand for the next page, or use "Search Signatures" to jump straight to a specific one.';
				return item;
			}
			case 'custom': {
				const item = new vscode.TreeItem(`Custom: ${node.path}`, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('folder-library');
				item.tooltip = 'Configured via vscode-flowr.config.solver.sigdb.customPath';
				return item;
			}
			case 'info': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('info');
				return item;
			}
		}
	}

	private scopeTreeItem(scope: Scope): vscode.TreeItem {
		const state = getSigDbScopeState(scope);
		const item = new vscode.TreeItem(ScopeLabel[scope], vscode.TreeItemCollapsibleState.Collapsed);

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${ScopeLabel[scope]}**\n\n${ScopeDescription[scope]}\n\n`);
		if(state.manifest) {
			// the manifest lists every shard's package count regardless of what is actually on disk (its index
			// is embedded) - report the two numbers separately rather than implying everything listed is usable
			const downloadedIds = getDownloadedShardIds(scope);
			const totalPackages = state.manifest.shards.reduce((sum, s) => sum + s.packages, 0);
			const downloadedPackages = state.manifest.shards.filter(s => downloadedIds.has(s.id)).reduce((sum, s) => sum + s.packages, 0);
			const complete = state.manifest.shards.every(s => downloadedIds.has(s.id));

			item.iconPath = new vscode.ThemeIcon(complete ? 'pass-filled' : 'circle-filled');
			item.description = complete
				? `${totalPackages} packages across ${state.manifest.shards.length} shard${state.manifest.shards.length === 1 ? '' : 's'}`
				: `${downloadedPackages} of ${totalPackages} packages downloaded`;

			md.appendMarkdown(`- **Manifest:** ${state.manifestPath}\n`);
			md.appendMarkdown(`- **Generated:** ${state.manifest.date}\n`);
			for(const shard of state.manifest.shards) {
				md.appendMarkdown(`- \`${shard.id}\`${downloadedIds.has(shard.id) ? '' : ' (not downloaded)'}: ${shard.packages} packages, ${shard.versions} versions\n`);
			}
			md.appendMarkdown('\nDecompressed shards are cached on disk and reused (see flowR\'s `sigDbCacheDir`) - opening the same package twice does not redecompress it.');
		} else {
			item.iconPath = new vscode.ThemeIcon('circle-outline');
			item.description = 'not downloaded';
			md.appendMarkdown('Not downloaded yet. Use the download icon on this row, or expand it, to sync.');
		}
		item.tooltip = md;
		item.contextValue = `sigdb-scope-${scope}-${state.manifest ? 'downloaded' : 'missing'}`;
		return item;
	}

	private syncTreeItem(scope: Scope): vscode.TreeItem {
		const item = new vscode.TreeItem(`↓ Download ${ScopeLabel[scope]}`, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('cloud-download');
		item.command = { title: 'Download', command: 'vscode-flowr.sigdb.downloadScope', arguments: [{ kind: 'scope', scope } satisfies SigDbNode] };

		const pointer = readSigDbRemotePointer();
		const md = new vscode.MarkdownString();
		if(pointer) {
			md.appendMarkdown(`**Download from:** https://github.com/${pointer.repo}/releases/tag/${pointer.tag}\n\n`);
			md.appendMarkdown(`**Destination:** ${getSigDbBundleDir() ?? getSigDbCacheDir()}\n\n`);
			md.appendMarkdown(SigDbShardGroups[scope].length > 1
				? 'Asks which shards to download; already-downloaded ones are skipped either way.'
				: 'Downloads every shard for this scope; already-downloaded shards are skipped.');
		} else {
			md.appendMarkdown('No release pointer bundled with this build of the extension.');
		}
		item.tooltip = md;
		return item;
	}

	private versionTreeItem(scope: Scope, pkg: string, version: string): vscode.TreeItem {
		const item = new vscode.TreeItem(version ? `v${version}` : '(unversioned)', vscode.TreeItemCollapsibleState.Collapsed);
		item.iconPath = new vscode.ThemeIcon('tag');
		return item;
	}

	private async functionTreeItem(node: { scope: Scope, pkg: string, version: string, name: string }): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('symbol-function');

		const source = await this.openScopeSource(node.scope);
		if(!source) {
			return item;
		}
		const version = node.version || undefined;
		try {
			const fn = source.functions(node.pkg, version)?.find(f => f.name === node.name);
			if(!fn) {
				return item;
			}

			const exportsInfo = source.lookup(node.pkg, version);
			const deprecated = fn.props.includes('deprecated') || (exportsInfo?.deprecated.includes(node.name) ?? false);
			const canThrow = fn.props.includes('can-throw');
			const nonDeterministic = fn.props.includes('non-deterministic');
			const s3generic = isSigDbFunctionS3Generic(source, node.pkg, node.name, version);
			const base = source.isBaseR(node.pkg);
			const cran = exportsInfo?.cran ?? false;
			const sourceUrl = cran && !base && fn.file ? cranMirrorSourceUrl(node.pkg, version, fn.file, fn.line) : undefined;
			const docUrl = rdrrDocUrl(node.pkg, node.name, { base, cran });

			item.description = `(${formatSignature(fn.signature)})${deprecated ? ' deprecated' : ''}${sourceUrl ? ' ↗' : ''}`;
			if(sourceUrl) {
				item.command = { title: 'Open Source', command: 'vscode.open', arguments: [vscode.Uri.parse(sourceUrl)] };
			}

			const md = new vscode.MarkdownString();
			md.appendMarkdown(`\`\`\`r\n${fn.name}(${formatSignature(fn.signature)})\n\`\`\`\n\n`);
			if(deprecated) {
				md.appendMarkdown('⚠️ **Deprecated**\n\n');
			}
			md.appendMarkdown(`${fn.exported ? 'Exported' : 'Internal'} function of \`${node.pkg}\`.\n`);
			const flags = [
				s3generic ? '🔀 S3 generic' : undefined,
				canThrow ? '⚠ can throw' : undefined,
				nonDeterministic ? '🎲 non-deterministic' : undefined
			].filter((f): f is string => !!f);
			if(flags.length > 0) {
				md.appendMarkdown(`\n${flags.join(' &nbsp;•&nbsp; ')}\n`);
			}
			if(fn.callees.length > 0) {
				md.appendMarkdown(`\n**Calls:** ${fn.callees.slice(0, 20).map(c => `\`${c}\``).join(', ')}${fn.callees.length > 20 ? ', …' : ''}\n`);
			}
			const links = [sourceUrl ? `[View source](${sourceUrl})` : undefined, docUrl ? `[Documentation](${docUrl})` : undefined].filter(Boolean);
			if(links.length > 0) {
				md.appendMarkdown(`\n${links.join(' · ')}\n`);
			}
			if(version) {
				md.appendMarkdown(`\n*via \`${node.scope}\` signature database, v${version}*`);
			}
			md.isTrusted = true;
			item.tooltip = md;
		} catch(e) {
			this.output.appendLine(`[SigDB] ${e instanceof Error ? e.message : String(e)}`);
		}
		return item;
	}
}

export interface SigDbSearchQuery {
	pkg:      string;
	version?: string;
	fnName?:  string;
}

/** parses `pkg`, `pkg::fn`, `pkg@version`, `pkg@version::fn` - globs (`*`/`?`) allowed in any part, same syntax as flowR's own `:signature` REPL command */
export function parseSigDbSearchQuery(query: string): SigDbSearchQuery | undefined {
	const fnSplit = query.split('::');
	const head = fnSplit[0]?.trim() ?? '';
	const fnName = fnSplit.length > 1 ? (fnSplit.slice(1).join('::').trim() || undefined) : undefined;
	if(!head) {
		return undefined;
	}
	const atIndex = head.indexOf('@');
	const pkg = (atIndex === -1 ? head : head.slice(0, atIndex)).trim();
	const version = atIndex === -1 ? undefined : (head.slice(atIndex + 1).trim() || undefined);
	return pkg ? { pkg, version, fnName } : undefined;
}

export interface SigDbSearchMatch {
	scope:    Scope;
	pkg:      string;
	version?: string;
	fnName?:  string;
}

/**
 * Resolves a parsed query against every downloaded scope, matching glob/exact package, version (glob, exact,
 * or a real `RRange`-parsed semver-ish constraint) and function names - the same wildcard semantics as flowR's
 * own `signature` query. A plain exact package name (the common case) stays a cheap `has()` check; only a
 * glob/version-constrained search has to scan every package in a scope.
 */
export async function findSigDbMatches(
	query: SigDbSearchQuery, output: vscode.OutputChannel, restrictTo: Scope | undefined, progress?: vscode.Progress<{ message?: string }>
): Promise<SigDbSearchMatch[]> {
	const { pkg: pkgPattern, version: versionPattern, fnName: fnPattern } = query;
	const pkgIsGlob = GlobChars.test(pkgPattern);
	const fnIsGlob = fnPattern !== undefined && GlobChars.test(fnPattern);
	const matches: SigDbSearchMatch[] = [];

	for(const scope of restrictTo ? [restrictTo] : Scopes) {
		const state = getSigDbScopeState(scope);
		if(!state.manifestPath) {
			continue;
		}

		const source = await safeGetSigSource(state.manifestPath, msg => output.appendLine(`[SigDB] ${msg}`));
		if(!source) {
			continue;
		}
		progress?.report({ message: `Scanning ${ScopeLabel[scope]}…` });

		const candidatePkgs = pkgIsGlob ? source.packageNames().filter(p => matchesPattern(pkgPattern, p)) : (source.has(pkgPattern) ? [pkgPattern] : []);
		for(const pkg of candidatePkgs) {
			let versions: (string | undefined)[];
			if(versionPattern) {
				versions = source.releaseDates(pkg).map(r => r.version.str).filter(v => matchesVersion(versionPattern, v));
				const latest = source.latestVersion(pkg)?.str;
				if(versions.length === 0 && latest && matchesVersion(versionPattern, latest)) {
					versions = [latest];
				}
			} else {
				versions = [source.latestVersion(pkg)?.str];
			}

			for(const version of versions) {
				if(fnPattern) {
					for(const fn of source.functions(pkg, version) ?? []) {
						if(fnIsGlob ? matchesPattern(fnPattern, fn.name) : fn.name === fnPattern) {
							matches.push({ scope, pkg, version, fnName: fn.name });
						}
					}
				} else {
					matches.push({ scope, pkg, version });
				}
			}
		}
	}
	return matches;
}

async function runSync(dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	const pointer = readSigDbRemotePointer();
	const choice = await vscode.window.showInformationMessage(
		pointer
			? `Sync signature databases from ${pointer.tag}? Already-downloaded shards are skipped.`
			: 'Sync signature databases from the latest flowR release?',
		'Sync',
		'Cancel'
	);
	if(choice !== 'Sync') {
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Syncing signature databases', cancellable: false },
		async progress => {
			let total = 0;
			let done = 0;
			const version = pointer?.tag.replace(/^sigdb-v/, '');
			try {
				const result = await downloadFullSigDb({
					version,
					onProgress: msg => {
						output.appendLine(`[SigDB] ${msg}`);
						const syncing = /^syncing (\d+) shards/.exec(msg);
						if(syncing) {
							total = Number(syncing[1]);
							return;
						}
						done++;
						progress.report({
							increment: total > 0 ? 100 / total : undefined,
							message:   total > 0 ? `${msg} (${done}/${total})` : msg
						});
					}
				});
				output.appendLine(`[SigDB] Sync complete: ${result.files.length} file(s) in ${result.dir}`);
				vscode.window.showInformationMessage(`Signature databases synced to ${result.dir}`);
			} catch(e) {
				const message = e instanceof Error ? e.message : String(e);
				output.appendLine(`[SigDB] Sync failed: ${message}`);
				vscode.window.showErrorMessage(`Signature database sync failed: ${message}`);
			}
			// an already-running flowR session bakes its sigdb paths in at construction time - refresh the
			// config and drop it so the next analysis actually sees what was just synced
			refreshSigDbConfig();
			dataProvider.refresh();
		}
	);
}

async function runDownloadScope(scope: Scope, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	const groups = SigDbShardGroups[scope];
	const downloaded = getDownloadedShardGroups(scope);
	let shardIds: string[] | undefined;
	let label = ScopeLabel[scope];

	if(groups.length > 1) {
		const picked = await vscode.window.showQuickPick(
			groups.map(g => ({ label: g.label, description: downloaded.has(g.id) ? 'already downloaded' : '', g })),
			{ placeHolder: `Which ${ScopeLabel[scope]} shards to download?` }
		);
		if(!picked) {
			return;
		}
		shardIds = picked.g.shardIds;
		label = `${ScopeLabel[scope]} (${picked.g.label})`;
	}

	const controller = new AbortController();
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Downloading ${label}`, cancellable: true },
		async(progress, cancelToken) => {
			cancelToken.onCancellationRequested(() => controller.abort());
			try {
				const result = await downloadSigDbScope(scope, msg => {
					output.appendLine(`[SigDB] ${msg}`);
					progress.report({ message: msg });
				}, controller.signal, shardIds);
				output.appendLine(`[SigDB] ${label} synced: ${result.files.length} file(s) in ${result.dir}`);
				vscode.window.showInformationMessage(`${label} downloaded.`);
			} catch(e) {
				if(!cancelToken.isCancellationRequested) {
					const message = e instanceof Error ? e.message : String(e);
					output.appendLine(`[SigDB] ${label} download failed: ${message}`);
					vscode.window.showErrorMessage(`Failed to download ${label}: ${message}`);
				}
			}
			refreshSigDbConfig();
			dataProvider.refresh();
		}
	);
}

async function runRemoveScope(scope: Scope, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel): Promise<void> {
	if(scope === 'base') {
		vscode.window.showWarningMessage('Base R signatures are required for basic symbol resolution and cannot be removed once downloaded.');
		return;
	}

	const groups = SigDbShardGroups[scope];
	const downloaded = getDownloadedShardGroups(scope);
	let shardIds: string[] | undefined;
	let label = ScopeLabel[scope];

	if(groups.length > 1) {
		const options = [
			...groups.filter(g => downloaded.has(g.id)).map(g => ({ label: g.label, g })),
			{ label: `Everything (all of ${ScopeLabel[scope]})`, g: undefined }
		];
		const picked = await vscode.window.showQuickPick(options, { placeHolder: `What to remove from ${ScopeLabel[scope]}?` });
		if(!picked) {
			return;
		}
		shardIds = picked.g?.shardIds;
		label = picked.g ? `${ScopeLabel[scope]} (${picked.g.label})` : ScopeLabel[scope];
	}

	const choice = await vscode.window.showWarningMessage(
		`Remove the downloaded "${label}" signature database from disk? It can be re-downloaded later.`,
		'Remove',
		'Cancel'
	);
	if(choice !== 'Remove') {
		return;
	}
	const { removed } = removeSigDbScope(scope, shardIds);
	output.appendLine(`[SigDB] Removed ${removed.length} file(s) for ${label}: ${removed.join(', ')}`);
	vscode.window.showInformationMessage(`${label} removed (${removed.length} file${removed.length === 1 ? '' : 's'}).`);
	refreshSigDbConfig();
	dataProvider.refresh();
}

/** the chain of ancestors from the root down to (and including) `node`, using getParent() */
function ancestorChain(dataProvider: SigDbTreeDataProvider, node: SigDbNode): SigDbNode[] {
	const chain: SigDbNode[] = [node];
	let current = node;
	for(;;) {
		const parent = dataProvider.getParent(current);
		if(!parent) {
			break;
		}
		chain.unshift(parent);
		current = parent;
	}
	return chain;
}

/**
 * Reveals `node` in the tree. VS Code's `TreeView.reveal()` walks the ancestor chain itself via
 * `getParent`/`getChildren`, but only finds an ancestor's *already-materialized* children - it will not
 * force a lazy scope/package to load. So we manually walk the chain top-down first (pinning + fetching
 * each level's children, which forces flowR to open the source and guarantees the target survives any
 * listing cap), then hand off to `reveal()` for the actual scrolling/selection.
 */
async function revealSafely(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, node: SigDbNode, output: vscode.OutputChannel, label: string): Promise<void> {
	const chain = ancestorChain(dataProvider, node);
	for(const n of chain) {
		dataProvider.pin(nodeId(n));
	}
	try {
		// the view is nested inside our own activity-bar container; the container itself needs revealing
		// before the individual view's own `.focus` command can actually render it
		await vscode.commands.executeCommand('workbench.view.extension.flowr');
		await vscode.commands.executeCommand(`${FlowrSigDbViewId}.focus`);
	} catch(e) {
		output.appendLine(`[SigDB] Could not focus the Signature DB view: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		// force every ancestor level to actually materialize before asking VS Code to find the leaf
		let parent: SigDbNode | undefined;
		for(const n of chain) {
			await dataProvider.getChildren(parent);
			parent = n;
		}
		await treeView.reveal(node, { select: true, focus: true, expand: true });
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		output.appendLine(`[SigDB] Could not reveal ${label} in the tree: ${message}`);
		vscode.window.showInformationMessage(`Found ${label}, but couldn't scroll to it in the tree (${message}) - open the Signature DB view and expand it manually.`);
	}
}

async function revealSearchMatch(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, m: SigDbSearchMatch, output: vscode.OutputChannel): Promise<void> {
	dataProvider.pin(nodeId({ kind: 'package', scope: m.scope, pkg: m.pkg }));
	if(m.fnName) {
		await revealSafely(treeView, dataProvider, { kind: 'function', scope: m.scope, pkg: m.pkg, version: m.version ?? '', name: m.fnName }, output, `"${m.pkg}::${m.fnName}"`);
	} else {
		await revealSafely(treeView, dataProvider, { kind: 'package', scope: m.scope, pkg: m.pkg }, output, `"${m.pkg}"`);
	}
}

async function runSearch(treeView: vscode.TreeView<SigDbNode>, dataProvider: SigDbTreeDataProvider, output: vscode.OutputChannel, restrictTo?: Scope): Promise<void> {
	const query = await vscode.window.showInputBox({
		prompt: restrictTo
			? `Package (or pkg@version, pkg::fn, pkg@version::fn - globs allowed) to look up in ${ScopeLabel[restrictTo]}`
			: 'Package (or pkg@version, pkg::fn, pkg@version::fn - globs allowed) to look up',
		placeHolder: 'e.g. ggplot2, ggplot2@3.5.0::ggplot, dplyr::mutate, ggplot2@3.*::ggp*'
	});
	if(!query) {
		return;
	}
	const parsed = parseSigDbSearchQuery(query);
	if(!parsed) {
		return;
	}

	let matches = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}"`, cancellable: false },
		progress => findSigDbMatches(parsed, output, restrictTo, progress)
	);

	// a bare term with no `::`/`@` is ambiguous - it is tried as a package name first, but if that finds
	// nothing, retry it as a function name across every package (mirrors flowR's own `:signature * <fn>` query)
	if(matches.length === 0 && !parsed.fnName && !parsed.version) {
		matches = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}" as a function name`, cancellable: false },
			progress => findSigDbMatches({ pkg: '*', fnName: parsed.pkg }, output, restrictTo, progress)
		);
	}

	if(matches.length === 0) {
		const where = restrictTo ? ScopeLabel[restrictTo] : 'any downloaded signature database';
		output.appendLine(`[SigDB] Search: "${query}" had no matches in ${where}`);
		vscode.window.showWarningMessage(`"${query}" had no matches in ${where}.`);
		return;
	}
	if(matches.length === 1) {
		await revealSearchMatch(treeView, dataProvider, matches[0], output);
		return;
	}

	const picked = await vscode.window.showQuickPick(
		matches.slice(0, 200).map(m => ({
			label:       m.fnName ? `${m.pkg}::${m.fnName}` : m.pkg,
			description: `${ScopeLabel[m.scope]}${m.version ? ` • v${m.version}` : ''}`,
			m
		})),
		{ placeHolder: `${matches.length} matches for "${query}"${matches.length > 200 ? ' (showing first 200)' : ''} - pick one` }
	);
	if(picked) {
		await revealSearchMatch(treeView, dataProvider, picked.m, output);
	}
}

/**
 * Registers the SigDB sidebar view. Every value shown is read live from disk (manifests, package/function
 * counts, download state) -- nothing here is estimated or hardcoded.
 */
export function registerSigDbView(context: vscode.ExtensionContext, output: vscode.OutputChannel): { dispose: () => void } {
	const dataProvider = new SigDbTreeDataProvider(output);
	const disposables: vscode.Disposable[] = [];

	const treeView = vscode.window.createTreeView(FlowrSigDbViewId, {
		treeDataProvider: dataProvider,
		showCollapseAll:  true
	});
	disposables.push(treeView, dataProvider);

	registerCommand(context, 'vscode-flowr.sigdb.refresh', () => {
		output.appendLine('[SigDB] Refreshing...');
		dataProvider.refresh();
	});

	registerCommand(context, 'vscode-flowr.sigdb.download', async() => {
		await runSync(dataProvider, output);
	});

	registerCommand(context, 'vscode-flowr.sigdb.downloadScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runDownloadScope(node.scope, dataProvider, output);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.removeScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runRemoveScope(node.scope, dataProvider, output);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.search', async() => {
		await runSearch(treeView, dataProvider, output);
	});

	registerCommand(context, 'vscode-flowr.sigdb.searchScope', async(node?: SigDbNode) => {
		if(node?.kind === 'scope') {
			await runSearch(treeView, dataProvider, output, node.scope);
		}
	});

	registerCommand(context, 'vscode-flowr.sigdb.settings.open', async() => {
		await vscode.commands.executeCommand('workbench.action.openSettings', `${Settings.Category}.config.solver.sigdb`);
	});

	disposables.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if(e.affectsConfiguration(Settings.Category)) {
				dataProvider.refresh();
			}
		})
	);

	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		dispose: (): void => disposables.forEach(d => d.dispose())
	};
}
