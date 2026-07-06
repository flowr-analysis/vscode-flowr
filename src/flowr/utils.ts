import * as vscode from 'vscode';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import type { SlicingCriterion, SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { Queries, QueryResults, SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import type { NormalizedAst, ParentInformation } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import type { DiagramSelectionMode } from './diagrams/diagram-definitions';
import type { CfgSimplificationPassName } from '@eagleoutice/flowr/control-flow/cfg-simplification';
import { RType } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/type';
import type { RExpressionList } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-expression-list';
import type { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';
import type { FlowrSearch } from '@eagleoutice/flowr/search/flowr-search-builder';
import { isNotUndefined } from '@eagleoutice/flowr/util/assert';

// Contains utility functions and a common interface for the two FlowrSession implementations

export interface SliceReturn {
	code:          string,
	sliceElements: { id: NodeId, location: SourceRange }[]
}

export interface FlowrSession {
	initialize:    () => void | Promise<void>
	destroy:       () => void
	retrieveSlice: (
		criteria: SlicingCriteria,
		direction: SliceDirection,
		document: vscode.TextDocument,
		showErrorMessage?: boolean,
		info?: { dfi: DataflowInformation, ast: NormalizedAst }
	) => Promise<SliceReturn>
	retrieveDataflowMermaid:  (document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified?: boolean) => Promise<string>
	retrieveAstMermaid:       (document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode) => Promise<string>
	retrieveCfgMermaid:       (document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified: boolean, simplifications: CfgSimplificationPassName[]) => Promise<string>
	retrieveCallgraphMermaid: (document: vscode.TextDocument, selections: readonly vscode.Selection[], selectionMode: DiagramSelectionMode, simplified?: boolean) => Promise<string>;
	retrieveQuery:            <T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>) => Promise<{ result: QueryResults<T>, hasError: boolean, dfi?: DataflowInformation, ast?: NormalizedAst }>
	runRepl:                  (output: Omit<FlowrReplOptions, 'parser'>) => Promise<void>
}

// Snaps to the enclosing word so positions on adjacent whitespace still hit the identifier.
/**
 *
 */
export function locationSearch(position: vscode.Position, document: vscode.TextDocument): FlowrSearch {
	const pos = getPositionAt(position, document)?.start ?? position;
	return {
		generator: {
			type: 'generator',
			name: 'get',
			args: { filter: {
				line:          pos.line + 1,
				column:        pos.character + 1,
				fuzzy:         true,
				innermostOnly: true
			} }
		},
		search: []
	};
}

/**
 * Resolves the flowR node id at the given editor position (or `undefined` if none can be found).
 */
export async function getNodeIdAt(position: vscode.Position, document: vscode.TextDocument, session: FlowrSession): Promise<NodeId | undefined> {
	const result = await session.retrieveQuery(document, [{ type: 'search', search: locationSearch(position, document) }]);
	return result.hasError ? undefined : result.result.search.results[0]?.ids[0];
}

/**
 * Maps a function-name symbol (what a location search resolves to for `print(x)`) to its enclosing call node,
 * which - unlike the name symbol - is a dataflow vertex. Non-call nodes are returned unchanged.
 */
export function toDataflowNode(ast: NormalizedAst, id: NodeId): NodeId {
	const parentId = ast.idMap.get(id)?.info.parent;
	if(parentId === undefined) {
		return id;
	}
	const parent = ast.idMap.get(parentId);
	if(parent?.type === RType.FunctionCall && parent.named && parent.functionName.info.id === id) {
		return parentId;
	}
	return id;
}

/**
 *
 */
export function getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
	const re = /([a-zA-Z0-9._])+/;
	const wordRange = document.getWordRangeAtPosition(position, re);
	return wordRange;
}

/**
 *
 */
export function consolidateNewlines(text: string) {
	return text.replace(/\r\n/g, '\n');
}


/**
 * Resolves each position to a slicing criterion in a single analysis pass, dropping positions that
 * do not map to a flowR node. The result may be shorter than `positions` (or empty).
 */
export async function makeSlicingCriteriaForPositions(positions: vscode.Position[], doc: vscode.TextDocument, session: FlowrSession): Promise<SlicingCriteria> {
	if(positions.length === 0) {
		return [];
	}
	const result = await session.retrieveQuery(doc, positions.map(pos => ({ type: 'search', search: locationSearch(pos, doc) } as const)));
	if(result.hasError) {
		return [];
	}
	const ast = result.ast;
	return result.result.search.results
		.map(r => r.ids[0])
		.filter(isNotUndefined)
		// map a function-name symbol to its call node so slicing on e.g. `print(x)` slices the call, not the bare name
		.map(id => ast ? toDataflowNode(ast, id) : id)
		.map(id => `$${id}` as SlicingCriterion);
}

/**
 *
 */
export function makeSliceElements(sliceResponse: ReadonlySet<NodeId>, idToLocation: (id: NodeId) => SourceRange | undefined): { id: NodeId, location: SourceRange }[] {
	const sliceElements: { id: NodeId, location: SourceRange }[] = [];
	for(const id of sliceResponse){
		const location = idToLocation(id);
		if(location){
			sliceElements.push({ id, location });
		}
	}

	// sort by start
	sliceElements.sort((a, b) => {
		return a.location[0] - b.location[0] || a.location[1] - b.location[1];
	});
	return sliceElements;
}

/**
 * Converts a flowR {@link SourceRange} into an equivalent {@link vscode.Range}. flowR positions are
 * 1-based while VS Code's are 0-based, so we subtract one - clamping to zero because `new vscode.Range`
 * throws on negative arguments, which would otherwise take down an entire diagnostics/decoration update
 * if flowR ever reports a finding without a proper location (e.g. a synthetic line 0).
 */
export function rangeToVscodeRange(range: SourceRange): vscode.Range {
	const clamp = (n: number) => n > 0 ? n : 0;
	return new vscode.Range(clamp(range[0] - 1), clamp(range[1] - 1), clamp(range[2] - 1), clamp(range[3]));
}

/**
 *
 */
export function selectionsToNodeIds(root: (RNode<ParentInformation> | RNode<ParentInformation>[]), selectionsRaw: readonly vscode.Selection[]): ReadonlySet<NodeId> | undefined {
	if(selectionsRaw.length === 0 || selectionsRaw[0].isEmpty) {
		return undefined;
	}

	const result = new Set<NodeId>();
	const maybeIncluded = new Array<RExpressionList<ParentInformation>>();

	// By default the end of the selection extends one more coloumn
	// Thus we subtract one so that the selection really only includes the selected chars
	const selections = selectionsRaw.map(sel => sel.with(
		sel.start,
		sel.end.with(sel.end.line, Math.max(sel.end.character - 1, 0))
	));

	RNode.visitAst(root, node => {
		if(node.type === RType.ExpressionList) {
			maybeIncluded.push(node);
			return;
		}

		const location = node.location ?? node.info.fullRange;
		if(location === undefined) {
			return;
		}

		const range = rangeToVscodeRange(location);
		if(selections.some(sel => sel.intersection(range) !== undefined)) {
			result.add(node.info.id);
		}
	});

	for(const maybe of maybeIncluded) {
		const shouldBeIncluded = maybe.children.length !== 0 && maybe.children.every(c => result.has(c.info.id));
		if(shouldBeIncluded) {
			result.add(maybe.info.id);
		}
	}

	return result;
}

export class RotaryBuffer<T> {
	private readonly buffer: T[];
	private index:           number = 0;

	constructor(size: number){
		this.buffer = new Array<T>(size);
	}

	push(item: T): void {
		if(this.buffer.length === 0){
			return;
		}
		this.buffer[this.index] = item;
		this.index = (this.index + 1) % this.buffer.length;
	}

	get(item: (t: T | undefined) => boolean): T | undefined {
		if(this.buffer.length === 0){
			return undefined;
		}
		return this.buffer.find(item);
	}

	size(): number {
		return this.buffer.length;
	}
}
