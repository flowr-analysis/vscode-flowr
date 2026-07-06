import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { locationSearch, rangeToVscodeRange, toDataflowNode } from './flowr/utils';
import { getOriginInDfg } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import type { Origin } from '@eagleoutice/flowr/dataflow/origin/dfg-get-origin';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';

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

interface ResolvedSymbol extends ResolvedOrigins {
	ast: NormalizedAst;
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

	private async resolve(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<ResolvedSymbol | undefined> {
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
			const resolved = originsForNode(res.dfi.graph, res.ast, id);
			if(!resolved) {
				return undefined;
			}
			return { origins: resolved.origins, ast: res.ast, id: resolved.id };
		} catch(e) {
			this.output.appendLine(`[Package Info] Error while resolving symbol: ${(e as Error).message}`);
			return undefined;
		}
	}

	async provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const resolved = await this.resolve(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}

		// we only contribute a hover when flowR can attribute the symbol to a package (i.e. it has a
		// namespace). Anything else - most prominently locally-defined variables and functions - is left to
		// the other hover providers (e.g. inferred values) and to the definition provider below, so that we
		// do not clutter every hover with redundant information.
		const qualified = Identifier.toQualified(resolved.origins);
		if(!qualified) {
			return undefined;
		}
		const namespace = Identifier.getNamespace(qualified);
		if(!namespace) {
			return undefined;
		}
		return new vscode.Hover(new vscode.MarkdownString(
			`**\`${Identifier.toString(qualified)}\`** is provided by the \`${namespace}\` package`
		));
	}

	async provideDefinition(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const resolved = await this.resolve(document, pos, token);
		if(!resolved || token.isCancellationRequested) {
			return undefined;
		}
		const locations = new Map<string, vscode.Location>();
		for(const origin of resolved.origins) {
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
