import type * as vscode from 'vscode';

import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import type { SingleSlicingCriterion, SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { Queries, QueryResults, SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';

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
		document: vscode.TextDocument,
		showErrorMessage?: boolean
	) => Promise<SliceReturn>
	retrieveDataflowMermaid: (document: vscode.TextDocument) => Promise<string>
	retrieveAstMermaid:      (document: vscode.TextDocument) => Promise<string>
	retrieveCfgMermaid:      (document: vscode.TextDocument) => Promise<string>
	retrieveQuery:           <T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>) => Promise<QueryResults<T>>
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

export class RotaryBuffer<T> {
	private readonly buffer: T[];
	private index:           number = 0;

	constructor(size: number){
		this.buffer = new Array<T>(size);
	}

	push(item: T): void {
		this.buffer[this.index] = item;
		this.index = (this.index + 1) % this.buffer.length;
	}

	get(item: (t: T | undefined) => boolean): T | undefined {
		return this.buffer.find(item);
	}
}