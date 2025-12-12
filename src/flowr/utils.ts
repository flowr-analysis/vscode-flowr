import * as vscode from 'vscode';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import type { SingleSlicingCriterion, SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { Queries, QueryResults, SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import type { NormalizedAst, ParentInformation } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import type { SliceDirection } from '@eagleoutice/flowr/core/steps/all/static-slicing/00-slice';
import { visitAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/visitor';
import type { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';

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
	retrieveDataflowMermaid: (document: vscode.TextDocument, selections: readonly vscode.Selection[], simplified?: boolean) => Promise<string>
	retrieveAstMermaid:      (document: vscode.TextDocument) => Promise<string>
	retrieveCfgMermaid:      (document: vscode.TextDocument) => Promise<string>
	retrieveQuery:           <T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>) => Promise<{ result: QueryResults<T>, hasError: boolean, dfi?: DataflowInformation, ast?: NormalizedAst }>
	runRepl:                 (output: Omit<FlowrReplOptions, 'parser'>) => Promise<void>
}

export function getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
	const re = /([a-zA-Z0-9._:])+/;
	const wordRange = document.getWordRangeAtPosition(position, re);
	return wordRange;
}

export function consolidateNewlines(text: string) {
	return text.replace(/\r\n/g, '\n');
}

function toSlicingCriterion(pos: vscode.Position): SingleSlicingCriterion {
	return `${pos.line + 1}:${pos.character + 1}`;
}

export function makeSlicingCriteria(positions: vscode.Position[], doc: vscode.TextDocument, verbose: boolean = true): SlicingCriteria {
	positions = positions.map(pos => {
		const range = getPositionAt(pos, doc);
		pos = range?.start ?? pos;
		if(verbose){
			console.log(`Extracting slice at ${pos.line + 1}:${pos.character + 1} in ${doc.fileName}`);
			console.log(`Token: ${doc.getText(range)}`);
		}
		return pos;
	});
	const criteria = positions.map(toSlicingCriterion);
	return criteria;
}

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
 * Converts a flowR {@link SourceRange} into an equivalent {@link vscode.Range}.
 */
export function rangeToVscodeRange(range: SourceRange): vscode.Range {
	return new vscode.Range(range[0] - 1, range[1] - 1, range[2] - 1, range[3]);
}

export function selectionsToNodeIds(root: (RNode<ParentInformation> | RNode<ParentInformation>[]), selections: readonly vscode.Selection[]): ReadonlySet<NodeId> {
	const result = new Set<NodeId>();
	
	visitAst(root, node => {
		if(!node.info.fullRange) {
			return;
		}

		const range = rangeToVscodeRange(node.info.fullRange);
		if(selections.some(sel => sel.intersection(range) !== undefined)) {
			result.add(node.info.id);
		}
	});

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
