import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { isRTypeLanguage } from './configurable-refresher';
import { isLocInDocument } from './lint';
import { rangeToVscodeRange } from './flowr/utils';
import { getConfig, Settings } from './settings';
import { rLanguageServerLive } from './completion';
import { buildDependencyQueries, unknownGuardedName } from './flowr/views/dependency-view';
import type { DisplayedCategoryName } from './flowr/views/dependency-view';
import { describePlots } from './flowr/views/plot-label';
import type { DependenciesQueryResult } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RNode as RNodeHelper } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RBinaryOp } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-binary-op';
import { RFunctionDefinition } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-definition';
import { RSymbol } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-symbol';
import { SourceLocation, SourceRange } from '@eagleoutice/flowr/util/range';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';

/** which symbols flowR provides: everything, only what the R language server does not know (the dependencies), or none */
export type SymbolScope = 'all' | 'dependencies' | 'none';

/** see {@link Settings.SymbolsWithRlanguageServer}: the R language server already lists the assignments of a file */
export function symbolScope(mode: string, languageServerLive: boolean): SymbolScope {
	if(!languageServerLive || mode === 'full') {
		return 'all';
	}
	return mode === 'off' ? 'none' : 'dependencies';
}

const DependencySymbols: Partial<Record<DisplayedCategoryName, { kind: vscode.SymbolKind, detail: string }>> = {
	library:    { kind: vscode.SymbolKind.Package, detail: 'library' },
	remote:     { kind: vscode.SymbolKind.Package, detail: 'remote install' },
	source:     { kind: vscode.SymbolKind.Module, detail: 'sourced script' },
	read:       { kind: vscode.SymbolKind.File, detail: 'imported data' },
	statistics: { kind: vscode.SymbolKind.Number, detail: 'statistical test' },
	test:       { kind: vscode.SymbolKind.Boolean, detail: 'test' },
	visualize:  { kind: vscode.SymbolKind.Event, detail: 'plot' },
	write:      { kind: vscode.SymbolKind.File, detail: 'output' }
};

const Assignments = new Set(['<-', '<<-', '=', '->', '->>']);

function rangeOf(node: RNode | undefined, span = false): vscode.Range | undefined {
	const range = span ? RNodeHelper.span(node) : SourceRange.fromNode(node);
	return range ? rangeToVscodeRange(range) : undefined;
}

/** the assignments of the file (functions with their nested assignments) and the dependencies flowR found in it */
export function buildDocumentSymbols(ast: NormalizedAst, document: vscode.TextDocument, scope: SymbolScope, dependencies?: DependenciesQueryResult): vscode.DocumentSymbol[] {
	if(scope === 'none') {
		return [];
	}
	const inDocument = (node: RNode | undefined) => {
		const loc = SourceLocation.fromNode(node);
		return loc !== undefined && isLocInDocument(loc, document);
	};
	const functions: vscode.DocumentSymbol[] = [];
	const symbols: vscode.DocumentSymbol[] = [];

	if(scope === 'all') {
		const seen = new Set<string>();
		const visited = new Set<RNode>();
		for(const node of ast.idMap.values()) {
			if(!RBinaryOp.is(node) || !Assignments.has(node.operator) || visited.has(node) || !inDocument(node)) {
				continue;
			}
			visited.add(node);
			const [target, value] = node.operator.startsWith('->') ? [node.rhs, node.lhs] : [node.lhs, node.rhs];
			const range = rangeOf(node, true);
			const selection = rangeOf(target);
			if(!RSymbol.is(target) || !range || !selection) {
				continue;
			}
			const name = Identifier.getName(target.content);
			const isFunction = RFunctionDefinition.is(value);
			const owner = RFunctionDefinition.wrappingFunctionDefinition(node, ast.idMap)?.info.id;
			// a reassignment in the same function (e.g. in a loop) would only repeat the name
			if(!isFunction && seen.has(`${String(owner)}:${name}`)) {
				continue;
			}
			seen.add(`${String(owner)}:${name}`);
			const detail = isFunction
				? `function(${value.parameters.map(p => Identifier.getName(p.name.content)).join(', ')})`
				: document.getText(rangeOf(value, true) ?? selection).split('\n')[0].slice(0, 60);
			const symbol = new vscode.DocumentSymbol(name, detail, isFunction ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable, range.union(selection), selection);
			(isFunction ? functions : symbols).push(symbol);
		}
	}

	if(dependencies) {
		const plots = describePlots(dependencies.visualize ?? [], dependencies.write ?? [], ast);
		for(const [category, display] of Object.entries(DependencySymbols) as [DisplayedCategoryName, { kind: vscode.SymbolKind, detail: string }][]) {
			for(const info of dependencies[category] ?? []) {
				const node = info.nodeId === undefined ? undefined : ast.idMap.get(info.nodeId);
				const range = rangeOf(node, true);
				if(!range || !inDocument(node) || (category === 'visualize' && info.linkedIds?.length)) {
					continue;
				}
				const name = category === 'visualize' ? plots.get(info) ?? unknownGuardedName(info) : unknownGuardedName(info);
				symbols.push(new vscode.DocumentSymbol(name || display.detail, display.detail, display.kind, range, range));
			}
		}
	}

	// nest everything (functions too) into the innermost function that contains it
	const all = [...functions, ...symbols].sort((a, b) => a.range.start.compareTo(b.range.start));
	const containers = functions.toSorted((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line));
	const roots: vscode.DocumentSymbol[] = [];
	for(const symbol of all) {
		const parent = containers.find(f => f !== symbol && f.range.contains(symbol.range) && !symbol.range.contains(f.range));
		(parent ? parent.children : roots).push(symbol);
	}
	return roots;
}

/** registers the document symbols (outline, breadcrumbs, "Go to Symbol in Editor") that flowR provides for R and R Markdown */
export function registerDocumentSymbols(output: vscode.OutputChannel): vscode.Disposable {
	const cache = new Map<string, Promise<vscode.DocumentSymbol[]>>();
	const compute = async(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> => {
		const scope = symbolScope(getConfig().get<string>(Settings.SymbolsWithRlanguageServer, 'complement'), await rLanguageServerLive());
		if(scope === 'none') {
			return [];
		}
		try {
			const { result, ast } = await (await getFlowrSession()).retrieveQuery(document, buildDependencyQueries());
			return ast ? buildDocumentSymbols(ast, document, scope, result.dependencies) : [];
		} catch(e) {
			output.appendLine(`[Symbols] failed: ${e instanceof Error ? e.message : String(e)}`);
			return [];
		}
	};
	return vscode.languages.registerDocumentSymbolProvider([{ language: 'r' }, { language: 'rmd' }], {
		provideDocumentSymbols(document) {
			if(!isRTypeLanguage(document) || !getConfig().get<boolean>(Settings.SymbolsEnabled, true)) {
				return [];
			}
			const key = `${document.uri.toString()}@${document.version}@${getConfig().get<string>(Settings.SymbolsWithRlanguageServer, 'complement')}`;
			let symbols = cache.get(key);
			if(!symbols) {
				symbols = compute(document);
				cache.clear();
				cache.set(key, symbols);
			}
			return symbols;
		}
	}, { label: 'flowR' });
}
