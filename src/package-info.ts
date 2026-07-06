import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { locationSearch, rangeToVscodeRange, toDataflowNode } from './flowr/utils';
import { getOriginInDfg } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import type { Origin } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import { RType } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/type';
import { getPackageDatabase, baseRPackages } from './package-db';
import { DefaultBuiltinConfig } from '@eagleoutice/flowr/dataflow/environments/default-builtin-config';

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

/** what flowR's package database knows about a package, formatted for a hover (version + optional CRAN link) */
function packageDbHover(pkg: string): string | undefined {
	const info = getPackageDatabase()?.lookup(pkg);
	if(!info) {
		return undefined;
	}
	const parts = [`database version ${info.version}`];
	if(info.cran) {
		// link to the package's CRAN landing page (plain https links are clickable in hovers)
		parts.push(`[CRAN](https://CRAN.R-project.org/package=${encodeURIComponent(pkg)})`);
	}
	return parts.join(' · ');
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
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	const disposables: vscode.Disposable[] = [];
	for(const selector of selectors) {
		disposables.push(
			vscode.languages.registerHoverProvider(selector, provider),
			vscode.languages.registerDefinitionProvider(selector, provider)
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

export class FlowrPackageInfoProvider implements vscode.HoverProvider, vscode.DefinitionProvider {
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	private async resolveNode(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<ResolvedNode | undefined> {
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
			this.output.appendLine(`[Package Info] Error while resolving symbol: ${(e as Error).message}`);
			return undefined;
		}
	}

	async provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}

		// case 1: a call attributed to a package (e.g. `ggplot` -> ggplot2). Show the plain name plus the package
		// and, if the database knows it, the resolved version. We deliberately leave locally-defined
		// variables/functions to the other hover providers so as not to clutter every hover.
		const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
		const qualified = origins && Identifier.toQualified(origins);
		const namespace = qualified && Identifier.getNamespace(qualified);
		if(qualified && namespace) {
			const db = packageDbHover(namespace);
			return new vscode.Hover(new vscode.MarkdownString(
				`**\`${Identifier.getName(qualified)}\`** is provided by the \`${namespace}\` package${db ? `\n\n${db}` : ''}`
			));
		}

		// case 2: a `library(pkg)`/`require(pkg)` load — hovering either the package name or the load function
		// itself shows the package's database version + CRAN link
		const loaded = loadedPackageAt(resolved.ast, resolved.id);
		if(loaded) {
			const subject = loaded.viaFunctionName ? `loads the \`${loaded.package}\` package` : `**\`${loaded.package}\`**`;
			const db = packageDbHover(loaded.package);
			return new vscode.Hover(new vscode.MarkdownString(
				db
					? `${subject} — ${db}`
					: `${subject}: not in the DB`
			));
		}

		// case 3: a call to a base/auto-loaded built-in (e.g. `print` -> base) that needs no `library()`
		const fnName = functionNameAt(resolved.ast, resolved.id);
		const basePackage = fnName && builtinBasePackageOf(fnName);
		if(fnName && basePackage) {
			return new vscode.Hover(new vscode.MarkdownString(
				`**\`${fnName}\`** is provided by the \`${basePackage}\` package`
			));
		}

		return undefined;
	}

	async provideDefinition(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const resolved = await this.resolveNode(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}
		const origins = originsForNode(resolved.graph, resolved.ast, resolved.id)?.origins;
		if(!origins) {
			return undefined;
		}
		const locations = new Map<string, vscode.Location>();
		for(const origin of origins) {
			if(!isLocalOrigin(origin)) {
				continue;
			}
			const loc = resolved.ast.idMap.get(origin.id)?.location;
			if(loc) {
				const range = rangeToVscodeRange(loc);
				// several origins (e.g. a function-call origin and the variable it was bound to) can point at the
				// same spot; collapse them so we do not offer the user duplicate jump targets
				locations.set(`${range.start.line}:${range.start.character}`, new vscode.Location(document.uri, range));
			}
		}
		return locations.size > 0 ? [...locations.values()] : undefined;
	}
}
