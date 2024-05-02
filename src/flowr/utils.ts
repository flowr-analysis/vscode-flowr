import type * as vscode from 'vscode'

import type { NodeId, SingleSlicingCriterion } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'

// Contains utility functions and a common interface for the two FlowrSession implementations

export interface SliceReturn {
	code:          string,
	sliceElements: { id: string, location: SourceRange }[]
}

export interface FlowrSession {
	initialize:    () => void | Promise<void>
	destroy:       () => void
	retrieveSlice: (
		positions: vscode.Position[],
		document: vscode.TextDocument,
		showErrorMessage?: boolean
	) => Promise<SliceReturn>
	retrieveDataflowMermaid: (document: vscode.TextDocument) => Promise<string>
}

export function getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
	const re = /([a-zA-Z0-9._:])+/
	const wordRange = document.getWordRangeAtPosition(position, re)
	return wordRange
}

export function consolidateNewlines(text: string) {
	return text.replace(/\r\n/g, '\n')
}

function toSlicingCriterion(pos: vscode.Position): SingleSlicingCriterion {
	return `${pos.line + 1}:${pos.character + 1}`
}

export function makeSlicingCriteria(positions: vscode.Position[], doc: vscode.TextDocument, verbose: boolean = true): SingleSlicingCriterion[] {
	positions = positions.map(pos => {
		const range = getPositionAt(pos, doc)
		pos = range?.start ?? pos
		if(verbose){
			console.log(`Extracting slice at ${pos.line + 1}:${pos.character + 1} in ${doc.fileName}`)
			console.log(`Token: ${doc.getText(range)}`)
		}
		return pos
	})
	const criteria = positions.map(toSlicingCriterion)
	return criteria
}

export function makeSliceElements(sliceResponse: Set<NodeId>, idToLocation: (id: string) => SourceRange | undefined): { id: string, location: SourceRange }[] {
	const sliceElements: { id: string, location: SourceRange }[] = []
	for(const id of sliceResponse){
		const location = idToLocation(id)
		if(location){
			sliceElements.push({ id, location })
		}
	}

	// sort by start
	sliceElements.sort((a, b) => {
		return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column
	})
	return sliceElements
}
