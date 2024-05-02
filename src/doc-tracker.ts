
// Contains the class and some functions that are used to track positions in a document
// and display ther slices

import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { makeUri, getReconstructionContentProvider, showUri } from './doc-provider'
import { getPositionAt } from './flowr/utils'
import type { DecoTypes } from './slice'
import { displaySlice, makeSliceDecorationTypes } from './slice'
import { getSelectionSlicer } from './selection-tracker'

const docTrackerAuthority = 'doc-tracker'
const docTrackerSuffix = 'Slice'

// A map of all active position trackers
// Trackers are removed when they have no more tracked positions
export const docTrackers: Map<vscode.TextDocument, PositionTracker> = new Map()


// Track the current cursor position(s) in the active editor
export async function trackCurrentPos(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const positions = editor.selections.map(sel => sel.start)
	await trackPositions(positions, editor.document)
}


// Track a list of positions in a document
export async function trackPositions(positions: vscode.Position[], doc: vscode.TextDocument): Promise<PositionTracker | undefined> {
	// Get or create a tracker for the document
	const flowrTracker = docTrackers.get(doc) || new PositionTracker(doc)
	if(!docTrackers.has(doc)){
		docTrackers.set(doc, flowrTracker)
	}
	
	// Try to toggle the indicated positions
	const ret = flowrTracker.togglePositions(positions)
	if(ret){
		// Update the output if any positions were toggled
		await flowrTracker.updateOutput()
	}

	if(flowrTracker.offsets.length === 0){
		// Dispose the tracker if no positions are tracked (anymore)
		flowrTracker.dispose()
		docTrackers.delete(doc)
		return undefined
	} else {
		// If the tracker is active, make sure there are no selection-slice decorations in its editors
		getSelectionSlicer().clearSliceDecos(undefined, doc)
	}
	return flowrTracker
}

class PositionTracker {
	listeners: ((e: vscode.Uri) => unknown)[] = []

	doc: vscode.TextDocument

	offsets: number[] = []

	sliceDecos: DecoTypes | undefined = undefined

	positionDeco: vscode.TextEditorDecorationType

	constructor(doc: vscode.TextDocument){
		this.doc = doc
		
		this.positionDeco = makeSliceDecorationTypes().trackedPos
		
		vscode.workspace.onDidChangeTextDocument(async(e) => {
			await this.onDocChange(e)
		})
	}

	dispose(): void {
		// Clear the content provider, decorations and tracked positions
		const provider = getReconstructionContentProvider()
		const uri = makeUri(docTrackerAuthority, docTrackerSuffix)
		provider.updateContents(uri, undefined)
		this.positionDeco?.dispose()
		this.sliceDecos?.dispose()
	}
	
	togglePositions(positions: vscode.Position[]): boolean {
		// convert positions to offsets
		let offsets = positions.map(pos => this.normalizeOffset(pos))
		offsets = offsets.filter(i => i >= 0)

		// return early if no valid offsets
		if(offsets.length === 0){
			return false
		}

		// add offsets that are not yet tracked
		let onlyRemove = true
		for(const offset of offsets){
			const idx = this.offsets.indexOf(offset)
			if(idx < 0){
				this.offsets.push(offset)
				onlyRemove = false
			}
		}

		// if all offsets are already tracked, toggle them off
		if(onlyRemove){
			this.offsets = this.offsets.filter(offset => !offsets.includes(offset))
		}

		return true
	}

	async showReconstruction(): Promise<vscode.TextEditor> {
		const uri = this.makeUri()
		return showUri(uri)
	}

	async updateOutput(): Promise<void> {
		const provider = getReconstructionContentProvider()
		this.updateTargetDecos()
		const code = await this.updateSlices() || '# No slice'
		const uri = this.makeUri()
		provider.updateContents(uri, code)
	}

	makeUri(): vscode.Uri {
		const docPath = this.doc.uri.path + ` - ${docTrackerSuffix}`
		return makeUri(docTrackerAuthority, docPath)
	}

	protected async onDocChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
		// Check if there are changes to the tracked document
		if(e.document !== this.doc) {
			return
		}
		if(e.contentChanges.length == 0){
			return
		}

		// Compute new tracked offsets after the changes
		const newOffsets: number[] = [	]
		for(let offset of this.offsets) {
			for(const cc of e.contentChanges) {
				const offset1 = shiftOffset(offset, cc)
				if(!offset1){
					offset = -1
					break
				} else {
					offset = offset1
				}
			}
			offset = this.normalizeOffset(offset)
			if(offset >= 0){
				newOffsets.push(offset)
			}
		}
		this.offsets = newOffsets
		
		// Update decos and editor output
		await this.updateOutput()
	}

	protected normalizeOffset(offsetOrPos: number | vscode.Position): number {
		// Convert a position to an offset and move it to the beginning of the word
		if(typeof offsetOrPos === 'number'){
			offsetOrPos = this.doc.positionAt(offsetOrPos)
		}
		const range = getPositionAt(offsetOrPos, this.doc)
		if(!range){
			return -1
		}
		return this.doc.offsetAt(range.start)
	}

	protected updateTargetDecos(): void {
		// Update the decorations in the editors that show the tracked positions
		const ranges = []
		for(const offset of this.offsets){
			const pos = this.doc.positionAt(offset)
			const range = getPositionAt(pos, this.doc)
			if(range){
				ranges.push(range)
			}
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc){
				this.sliceDecos ||= makeSliceDecorationTypes()
				editor.setDecorations(this.positionDeco, ranges)
			}
		}
	}

	protected async updateSlices(): Promise<string | undefined> {
		// Update the decos that show the slice results
		const session = await getFlowrSession()
		const positions = this.offsets.map(offset => this.doc.positionAt(offset))
		if(positions.length === 0){
			this.clearSliceDecos()
			return
		}
		const { code, sliceElements } = await session.retrieveSlice(positions, this.doc)
		if(sliceElements.length === 0){
			this.clearSliceDecos()
			return
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc) {
				this.sliceDecos ||= makeSliceDecorationTypes()
				void displaySlice(editor, sliceElements, this.sliceDecos)
			}
		}
		return code
	}

	protected clearSliceDecos(): void {
		this.sliceDecos?.dispose()
		this.sliceDecos = undefined
	}
}

function shiftOffset(offset: number, cc: vscode.TextDocumentContentChangeEvent): number | undefined {
	if(cc.rangeOffset > offset){
		// pos is before range -> no change
		return offset
	}
	if(cc.rangeLength + cc.rangeOffset > offset){
		// pos is inside range -> invalidate pos
		return undefined
	}
	// pos is after range -> adjust pos
	const offsetDelta = cc.text.length - cc.rangeLength
	const offset1 = offset + offsetDelta
	return offset1
}
