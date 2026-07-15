import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { locationSearch, rangeToVscodeRange, toDataflowNode } from './flowr/utils';
import { getOriginInDfg } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import type { Origin } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import { VertexType, isVariableDefinitionVertex } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { DfEdge, EdgeType } from '@eagleoutice/flowr/dataflow/graph/edge';
import { RType } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/type';
import { baseRPackages, getSigDbScopeState, findSigDbPackageSource, resolveSigDbPackageVersion, rMajorVersionPageUrl } from './package-db';
import type { SignatureFunctionView, SignaturePackageView, SignatureQueryResult, SignatureDependencyView } from '@eagleoutice/flowr/queries/catalog/signature-query/signature-query-format';
import {
	DefaultBuiltinConfig, GgPlotCreate, TinyPlotCrate, GraphicsPlotCreate, PlotCreate,
	TinyPlotAddons, GraphicsPlotAddons, GgPlotAddons
} from '@eagleoutice/flowr/dataflow/environments/default-builtin-config';

const SigDbScopes = ['base', 'current', 'history'] as const;

/**
 * flowR's builtin configuration attributes each built-in to its package. We expose only the base/auto-loaded
 * packages here (e.g. `print` from `base`): non-base attributions (ggplot2, dplyr, …) require an explicit
 * `library()` and are surfaced through the dataflow origins instead, only when the package is actually loaded.
 */
let builtinBasePackages: Map<string, string> | undefined;
function builtinBasePackageOf(name: string): string | undefined {
	if(!builtinBasePackages) {
		builtinBasePackages = new Map();
		for(const entry of DefaultBuiltinConfig) {
			for(const declared of entry.names ?? []) {
				if(Array.isArray(declared) && baseRPackages.has(declared[1])) {
					builtinBasePackages.set(declared[0], declared[1]);
				}
			}
		}
	}
	return builtinBasePackages.get(name);
}

/** functions whose (first) argument names a package to load */
const libraryLoadFunctions = new Set(['library', 'require', 'loadNamespace', 'requireNamespace', 'attachNamespace']);

/**
 * Names flowR's builtin config special-cases even though they belong to a real package (e.g. `ggplot`
 * becomes "Built-In" in the dataflow graph so flowR can model plot output without needing library()
 * resolution). A real cross-package signature-database lookup is only attempted for names in this set -
 * it has to scan every mounted package, so it's too expensive to run for every unresolved hover otherwise.
 */
const nonBaseBuiltinNames = new Set([
	...GgPlotCreate, ...TinyPlotCrate, ...GraphicsPlotCreate, ...PlotCreate,
	...TinyPlotAddons, ...GraphicsPlotAddons, ...GgPlotAddons
]);

/** whether any scope (base/current/history) has actually been synced to disk */
function anySigDbScopeDownloaded(): boolean {
	return SigDbScopes.some(scope => getSigDbScopeState(scope).manifest);
}

/** the "not resolved" hover text, distinguishing "nothing downloaded yet" from "downloaded but this package isn't in it" */
function sigDbMissingHint(): string {
	return anySigDbScopeDownloaded()
		? 'not in the downloaded signature database(s)'
		: 'no signature database downloaded yet — see the Signature DB view';
}

/** runs flowR's real `signature` query against the active session - all URL/deprecated/S3-generic logic lives there, not reimplemented here */
async function runSignatureQuery(document: vscode.TextDocument, pkg: string | undefined, fnName: string | undefined, output: vscode.OutputChannel): Promise<SignatureQueryResult | undefined> {
	try {
		const session = await getFlowrSession();
		const { result, hasError } = await session.retrieveQuery(document, [{ type: 'signature', package: pkg, function: fnName }]);
		return hasError ? undefined : result.signature;
	} catch(e) {
		output.appendLine(`[Package Info] signature query failed: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

/**
 * The scope (`base`/`current`/`history`) whose on-disk database actually knows `pkg`, for attribution in
 * hover text. flowR's `signature` query result does not report which of the (possibly several) mounted
 * scopes answered a lookup, and the sharded reader does not expose which *shard file* within a scope a
 * package's data came from either - the scope is the finest-grained attribution available.
 */
async function resolveSigDbScopeLabel(pkg: string): Promise<string | undefined> {
	return (await findSigDbPackageSource(pkg))?.scope;
}

function formatFunctionView(fn: SignatureFunctionView, scope?: string): string {
	const link = fn.sourceUrl ? `[\`${fn.package}::${fn.name}\`](${fn.sourceUrl})` : `\`${fn.package}::${fn.name}\``;
	const parts = [`resolved via the${scope ? ` \`${scope}\`` : ''} signature database as ${link}`];
	if(fn.version) {
		parts.push(`\`v${fn.version}\``);
	}
	if(fn.docUrl) {
		parts.push(`[documentation](${fn.docUrl})`);
	}
	const flags = [
		fn.properties.includes('deprecated') ? '⚠ deprecated' : undefined,
		fn.properties.includes('can-throw') ? '⚠ can throw' : undefined,
		fn.s3generic ? '🔀 S3 generic' : undefined
	].filter((f): f is string => !!f);
	const summary = parts.join(' · ');
	return flags.length > 0 ? `${summary}\n\n${flags.join(' • ')}` : summary;
}

function formatPackageView(pkg: SignaturePackageView, scope?: string): string {
	const link = pkg.repoUrl ?? pkg.cranPage;
	const label = link ? `[\`${pkg.name}\`](${link})` : `\`${pkg.name}\``;
	const parts = [`resolved via the${scope ? ` \`${scope}\`` : ''} signature database as ${label}`, `\`v${pkg.version}\``, `${pkg.functionCount} functions`];
	if(pkg.cranPage) {
		parts.push(`[CRAN](${pkg.cranPage})`);
	}
	let text = parts.join(' · ');
	if(pkg.dependencies.length > 0) {
		text += `\n\n${formatGroupedDependencies(pkg.dependencies)}`;
	}
	return text;
}

/** DESCRIPTION dependency field order (the ones users actually care about distinguishing first); anything else keeps its first-seen order after these */
const DependencyTypeOrder = ['Depends', 'Imports', 'LinkingTo', 'Suggests', 'Enhances'];

/** groups dependencies by their DESCRIPTION field (Imports, Suggests, ...), one comma-separated line per group */
function formatGroupedDependencies(dependencies: readonly SignatureDependencyView[]): string {
	const byType = new Map<string, string[]>();
	for(const d of dependencies) {
		const label = d.constraint ? `\`${d.name}\` \`${d.constraint}\`` : `\`${d.name}\``;
		const labels = byType.get(d.type) ?? [];
		labels.push(label);
		byType.set(d.type, labels);
	}
	const rank = (type: string) => {
		const i = DependencyTypeOrder.indexOf(type);
		return i === -1 ? DependencyTypeOrder.length : i;
	};
	return [...byType.entries()]
		.sort(([a], [b]) => rank(a) - rank(b))
		.map(([type, labels]) => `**${type}:** ${labels.join(', ')}`)
		.join('\n\n');
}

/** the name of the function called at (or named by) the node at `id`, if it is a named call */
function functionNameAt(ast: NormalizedAst, id: NodeId): string | undefined {
	const node = ast.idMap.get(toDataflowNode(ast, id));
	return node?.type === RType.FunctionCall && node.named ? node.functionName.lexeme ?? undefined : undefined;
}

function unquote(lexeme: string | undefined): string | undefined {
	return (lexeme ?? '').replace(/^["'`]|["'`]$/g, '') || undefined;
}

/**
 * Resolves the package loaded by a `library()`/`require()`-style call when hovering *either* its package-name
 * argument (`library(ggplot2)` on `ggplot2`) *or* the load function itself (`library(ggplot2)` on `library`).
 * `viaFunctionName` distinguishes the two so the hover can phrase it accordingly.
 */
function loadedPackageAt(ast: NormalizedAst, id: NodeId): { package: string, viaFunctionName: boolean } | undefined {
	const node = ast.idMap.get(id);
	// (a) hovering the package name argument: value -> RArgument -> call
	if(node && (node.type === RType.Symbol || node.type === RType.String)) {
		const argId = node.info.parent;
		const call = argId !== undefined ? ast.idMap.get(ast.idMap.get(argId)?.info.parent ?? '') : undefined;
		if(call?.type === RType.FunctionCall && call.named && libraryLoadFunctions.has(call.functionName.lexeme ?? '')) {
			const pkg = unquote(node.lexeme);
			return pkg ? { package: pkg, viaFunctionName: false } : undefined;
		}
	}
	// (b) hovering the load function itself: take its first argument as the package
	const call = ast.idMap.get(toDataflowNode(ast, id));
	if(call?.type === RType.FunctionCall && call.named && libraryLoadFunctions.has(call.functionName.lexeme ?? '')) {
		const first = call.arguments[0];
		const pkg = first && typeof first === 'object' && first.type === RType.Argument ? unquote(first.value?.lexeme) : undefined;
		return pkg ? { package: pkg, viaFunctionName: true } : undefined;
	}
	return undefined;
}

/**
 * Registers a hover- and a definition-provider that use flowR's dataflow origins (via
 * {@link Identifier.toQualified}) to tell the user which package a called function stems from and,
 * where flowR knows a definition location (e.g. a locally-defined function or variable), to let them
 * jump to it via <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click.
 */
export function registerPackageInfo(output: vscode.OutputChannel): vscode.Disposable[] {
	const provider = new FlowrPackageInfoProvider(output);
	const referenceProvider = new FlowrReferenceProvider(output);
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	const disposables: vscode.Disposable[] = [
		vscode.workspace.registerTextDocumentContentProvider(RemoteLinkRedirectScheme, new RemoteLinkRedirectProvider())
	];
	for(const selector of selectors) {
		disposables.push(
			vscode.languages.registerHoverProvider(selector, provider),
			vscode.languages.registerDefinitionProvider(selector, provider),
			vscode.languages.registerReferenceProvider(selector, referenceProvider)
		);
	}
	return disposables;
}

/** the dataflow origins flowR knows for a node, together with the node they were ultimately resolved from */
interface ResolvedOrigins {
	origins: readonly Origin[];
	id:      NodeId;
}

/** the node the location search resolved to, with the AST and dataflow graph it came from */
interface ResolvedNode {
	id:    NodeId;
	ast:   NormalizedAst;
	graph: DataflowGraph;
}

/** an origin that carries a source-level definition (i.e. not a built-in function) */
function isLocalOrigin(origin: Origin): origin is Exclude<Origin, { readonly proc: string }> {
	return !('proc' in origin);
}

/**
 * Looks up the dataflow origins for the node the user pointed at. A location search resolves to the
 * innermost node, which for a call like `map(...)` is the function-name *symbol* - but flowR attaches the
 * origins (and hence the package attribution) to the enclosing *function-call* node. So when the symbol
 * itself has no origins, we climb to its parent call and use that instead.
 */
function originsForNode(graph: DataflowGraph, ast: NormalizedAst, id: NodeId): ResolvedOrigins | undefined {
	const direct = getOriginInDfg(graph, id);
	if(direct && direct.length > 0) {
		return { origins: direct, id };
	}
	// the location search resolves to the function-name symbol; the origins live on the enclosing call node
	const callId = toDataflowNode(ast, id);
	if(callId !== id) {
		const viaCall = getOriginInDfg(graph, callId);
		if(viaCall && viaCall.length > 0) {
			return { origins: viaCall, id: callId };
		}
	}
	return undefined;
}

/** resolves the AST/dataflow node the user pointed at, shared by the hover/definition and reference providers */
async function resolveNode(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken, output: vscode.OutputChannel): Promise<ResolvedNode | undefined> {
	const session = await getFlowrSession();
	if(!session || token.isCancellationRequested) {
		return undefined;
	}
	try {
		const res = await session.retrieveQuery(document, [{ type: 'search', search: locationSearch(pos, document) }]);
		if(token.isCancellationRequested || res.hasError || !res.dfi || !res.ast) {
			return undefined;
		}
		const id = res.result.search.results[0]?.ids[0];
		if(id === undefined) {
			return undefined;
		}
		return { id, ast: res.ast, graph: res.dfi.graph };
	} catch(e) {
		output.appendLine(`[Package Info] Error while resolving symbol: ${(e as Error).message}`);
		return undefined;
	}
}

/** the node at `id` itself if it is a variable/function definition vertex, otherwise the local definition its origin points to (if any) */
function definitionIdFor(resolved: ResolvedNode): NodeId | undefined {
	const vertex = resolved.graph.getVertex(resolved.id) ?? resolved.graph.getVertex(toDataflowNode(resolved.ast, resolved.id));
	if(vertex && (isVariableDefinitionVertex(vertex) || vertex.tag === VertexType.FunctionDefinition)) {
		return resolved.id;
	}
	const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
	return origins?.find(isLocalOrigin)?.id;
}

export class FlowrPackageInfoProvider implements vscode.HoverProvider, vscode.DefinitionProvider {
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	private async resolveNode(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<ResolvedNode | undefined> {
		return resolveNode(document, pos, token, this.output);
	}

	/**
	 * The package/function attribution for the node the user pointed at, covering the same four cases for
	 * both hover text and "go to definition": (1) a call attributed to a package via dataflow origins, (2) a
	 * `library()`/`require()` load, (3) a base/auto-loaded builtin, (4) a non-base builtin flowR special-cases
	 * (e.g. `ggplot`) that the signature database also happens to know. `url` is only set when a real remote
	 * link (CRAN mirror source, or the package's CRAN page) is known - `provideDefinition` uses it to jump out.
	 */
	private async resolveSigDbInfo(resolved: ResolvedNode, document: vscode.TextDocument): Promise<{ text: string, url?: string } | undefined> {
		// case 1: a call attributed to a package (e.g. `ggplot` -> ggplot2). We deliberately leave locally-defined
		// variables/functions to the other hover providers so as not to clutter every hover.
		const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
		const qualified = origins && Identifier.toQualified(origins);
		const namespace = qualified && Identifier.getNamespace(qualified);
		if(qualified && namespace) {
			const fnName = Identifier.getName(qualified);
			const [result, scope] = await Promise.all([runSignatureQuery(document, namespace, fnName, this.output), resolveSigDbScopeLabel(namespace)]);
			return {
				text: `**\`${fnName}\`** is provided by the \`${namespace}\` package${result?.function ? `\n\n${formatFunctionView(result.function, scope)}` : ''}`,
				url:  result?.function?.sourceUrl
			};
		}

		// case 2: a `library(pkg)`/`require(pkg)` load — jumps to the package's CRAN page
		const loaded = loadedPackageAt(resolved.ast, resolved.id);
		if(loaded) {
			const subject = loaded.viaFunctionName ? `loads the \`${loaded.package}\` package` : `**\`${loaded.package}\`**`;
			const [result, scope] = await Promise.all([runSignatureQuery(document, loaded.package, undefined, this.output), resolveSigDbScopeLabel(loaded.package)]);
			return {
				text: result?.package ? `${subject} — ${formatPackageView(result.package, scope)}` : `${subject}: ${sigDbMissingHint()}`,
				url:  result?.package?.repoUrl ?? result?.package?.cranPage
			};
		}

		// case 3: a call to a base/auto-loaded built-in (e.g. `print` -> base) that needs no `library()` - base R
		// isn't mirrored on GitHub the way CRAN packages are, so there is no source link, only a version
		const fnName = functionNameAt(resolved.ast, resolved.id);
		const basePackage = fnName && builtinBasePackageOf(fnName);
		if(fnName && basePackage) {
			const version = await resolveSigDbPackageVersion(basePackage);
			const rVersionPage = version && rMajorVersionPageUrl(version);
			const pkgLabel = rVersionPage ? `[\`${basePackage}\`](${rVersionPage})` : `\`${basePackage}\``;
			return { text: `**\`${fnName}\`** is provided by the ${pkgLabel} package${version ? ` \`v${version}\`` : ''}` };
		}

		// case 4: flowR pre-registers some non-base functions (e.g. `ggplot`) as built-ins so it can model their
		// behavior (producing plot output) without a full library() resolution. That classification wins in the
		// dataflow graph, but if the signature database happens to know a real package for the same name, surface
		// it (and its source link) too instead of staying silent. A wildcard (package-less) query only returns
		// compact matches, so re-query the top hit by exact package+name for the full view (S3/deprecated/etc).
		if(fnName && nonBaseBuiltinNames.has(fnName) && anySigDbScopeDownloaded()) {
			const wildcard = await runSignatureQuery(document, undefined, fnName, this.output);
			const hit = wildcard?.matches?.[0];
			const [result, scope] = hit
				? await Promise.all([runSignatureQuery(document, hit.package, hit.name, this.output), resolveSigDbScopeLabel(hit.package)])
				: [undefined, undefined];
			if(result?.function) {
				return {
					text: `**\`${fnName}\`** is treated as a built-in by flowR (for output/dependency tracking), but the signature database also knows it as ${formatFunctionView(result.function, scope)}`,
					url:  result.function.sourceUrl
				};
			}
		}

		return undefined;
	}

	async provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}
		const info = await this.resolveSigDbInfo(resolved, document);
		return info ? new vscode.Hover(new vscode.MarkdownString(info.text)) : undefined;
	}

	async provideDefinition(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}

		// two cases where flowR's dataflow origins are misleading, not a real user-editable local definition:
		// (1) names like `ggplot` that flowR pre-registers as built-ins (see `nonBaseBuiltinNames`), modeled
		// with an AST-attached origin that happens to satisfy `isLocalOrigin`; (2) a `library(pkg)`/`require(pkg)`
		// package-name argument, which flowR's NSE-unaware dataflow may try to resolve as an ordinary variable
		// read. Skip the local-origin lookup for both and go straight to the real remote link.
		const fnName = functionNameAt(resolved.ast, resolved.id);
		const isPackageNameArg = !!loadedPackageAt(resolved.ast, resolved.id);
		if(!(fnName && nonBaseBuiltinNames.has(fnName)) && !isPackageNameArg) {
			const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
			const locations = new Map<string, vscode.Location>();
			for(const origin of origins ?? []) {
				if(!isLocalOrigin(origin)) {
					continue;
				}
				const loc = resolved.ast.idMap.get(origin.id)?.location;
				if(loc) {
					const range = rangeToVscodeRange(loc);
					// several origins (e.g. a function-call origin and the variable it was bound to) can point at
					// the same spot; collapse them so we do not offer the user duplicate jump targets
					locations.set(`${range.start.line}:${range.start.character}`, new vscode.Location(document.uri, range));
				}
			}
			if(locations.size > 0) {
				return [...locations.values()];
			}
		}

		// a remote-only target (a package function's source, a library()'s CRAN page) is reported as a Location
		// too, so Ctrl+hover underlines it exactly like a local one - see `RemoteLinkRedirectUri`/
		// `RemoteLinkRedirectProvider` below for how "opening" that Location redirects to a real browser only
		// on an actual navigation (click), never merely from the speculative call VS Code makes on Ctrl+hover.
		const info = await this.resolveSigDbInfo(resolved, document);
		if(info?.url) {
			return new vscode.Location(remoteLinkRedirectUri(info.url), new vscode.Position(0, 0));
		}

		// clicking a variable/function at its own definition (not a use of it) has no "origin" to resolve - it
		// is not a read of anything upstream - so the lookups above always come up empty there. Report the
		// definition as its own location instead of nothing, matching how most language servers treat this
		// (VS Code then just leaves the cursor in place rather than showing "no references found").
		const vertex = resolved.graph.getVertex(resolved.id) ?? resolved.graph.getVertex(toDataflowNode(resolved.ast, resolved.id));
		if(vertex && (isVariableDefinitionVertex(vertex) || vertex.tag === VertexType.FunctionDefinition)) {
			const loc = resolved.ast.idMap.get(resolved.id)?.location;
			if(loc) {
				return new vscode.Location(document.uri, rangeToVscodeRange(loc));
			}
		}
		return undefined;
	}
}

/**
 * "Find All References"/right-click "Find All References" for local variables and functions, via flowR's
 * dataflow graph: every node with a `Reads` edge into the definition is a use of it. Without this, clicking a
 * definition whose "go to definition" target is itself falls back to VS Code's built-in reference search, which
 * (with no provider registered) always reports "No references found" - misleading, since real references exist.
 */
export class FlowrReferenceProvider implements vscode.ReferenceProvider {
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	async provideReferences(document: vscode.TextDocument, pos: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const resolved = await resolveNode(document, pos, token, this.output);
		if(!resolved || token.isCancellationRequested) {
			return [];
		}
		const defId = definitionIdFor(resolved);
		if(defId === undefined) {
			return [];
		}

		const locations = new Map<string, vscode.Location>();
		const addLocation = (id: NodeId) => {
			const loc = resolved.ast.idMap.get(id)?.location;
			if(loc) {
				const range = rangeToVscodeRange(loc);
				locations.set(`${range.start.line}:${range.start.character}`, new vscode.Location(document.uri, range));
			}
		};

		if(context.includeDeclaration) {
			addLocation(defId);
		}
		for(const [sourceId, edge] of resolved.graph.ingoingEdges(defId) ?? []) {
			if(DfEdge.includesType(edge, EdgeType.Reads)) {
				addLocation(sourceId);
			}
		}
		return [...locations.values()];
	}
}

export const RemoteLinkRedirectScheme = 'flowr-remote-link';

/** a fake document URI that `RemoteLinkRedirectProvider` resolves by opening `target` externally */
export function remoteLinkRedirectUri(target: string): vscode.Uri {
	return vscode.Uri.from({ scheme: RemoteLinkRedirectScheme, path: `/${encodeURIComponent(target)}` });
}

/**
 * Backs the Ctrl+click Location returned for remote-only targets. VS Code only calls
 * `provideTextDocumentContent` when it actually tries to open the document - i.e. on a real click navigation,
 * never for the speculative `provideDefinition` call it makes just from Ctrl+hovering - so the browser opens
 * exactly once, only on click. The placeholder tab this briefly opens is closed right after.
 */
export class RemoteLinkRedirectProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		const target = decodeURIComponent(uri.path.replace(/^\//, ''));
		void vscode.env.openExternal(vscode.Uri.parse(target));
		void closeRedirectTab(uri);
		return `Opened ${target} in your browser…`;
	}
}

function findRedirectTab(uri: vscode.Uri): vscode.Tab | undefined {
	const target = uri.toString();
	for(const group of vscode.window.tabGroups.all) {
		for(const tab of group.tabs) {
			if(tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target) {
				return tab;
			}
		}
	}
	return undefined;
}

/** closes the placeholder tab as soon as it actually appears, rather than guessing a fixed delay - falls back to a short timeout in case the tab-open event is ever missed */
async function closeRedirectTab(uri: vscode.Uri): Promise<void> {
	const existing = findRedirectTab(uri);
	if(existing) {
		await vscode.window.tabGroups.close(existing);
		return;
	}
	await new Promise<void>(resolve => {
		const timeout = setTimeout(() => {
			listener.dispose();
			resolve();
		}, 2000);
		const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
			const tab = findRedirectTab(uri);
			if(tab) {
				clearTimeout(timeout);
				listener.dispose();
				void vscode.window.tabGroups.close(tab).then(() => resolve());
			}
		});
	});
}
