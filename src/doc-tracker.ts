import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { makeUri, getReconstructionContentProvider } from './doc-provider'
import { getPositionAt } from './flowr/utils'
import type { DecoTypes } from './slice'
import { displaySlice, makeSliceDecorationTypes } from './slice'
import * as path from 'path'
import { getSelectionSlicer } from './selection-tracker'

const docTrackerAuthority = 'doc-tracker'
const docTrackerPath = 'Slice'

export const docTrackers: Map<vscode.TextDocument, FlowrTracker> = new Map()

export async function trackCurrentPos(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const pos = editor.selection.start
	await trackPos(pos, editor.document)
	// await showTrackedSlice()
}

export async function showTrackedSlice(): Promise<vscode.TextEditor | undefined> {
	const uri = makeUri(docTrackerAuthority, docTrackerPath)
	for(const editor of vscode.window.visibleTextEditors){
		if(editor.document.uri.toString() === uri.toString()){
			return editor
		}
	}
	const provider = getReconstructionContentProvider()
	if(provider.contents.has(uri.toString())){
		const doc = await vscode.workspace.openTextDocument(uri)
		await vscode.languages.setTextDocumentLanguage(doc, 'r')
		return await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Beside
		})
	}
	return undefined
}

export async function trackPos(pos: vscode.Position, doc: vscode.TextDocument): Promise<FlowrTracker | undefined> {
	const flowrTracker = docTrackers.get(doc) || new FlowrTracker(doc)
	if(!docTrackers.has(doc)){
		docTrackers.set(doc, flowrTracker)
	}
	const ret = flowrTracker.togglePosition(pos)
	if(ret){
		await flowrTracker.updateOutput()
	}
	if(flowrTracker.offsets.length === 0){
		flowrTracker.dispose()
		docTrackers.delete(doc)
		return undefined
	} else {
		getSelectionSlicer().clearSliceDecos(undefined, doc)
	}
	return flowrTracker
}

class FlowrTracker {
	listeners: ((e: vscode.Uri) => unknown)[] = []

	doc: vscode.TextDocument

	offsets: number[] = []
	
	decos: DecoTypes | undefined = undefined
	
	constructor(doc: vscode.TextDocument){
		this.doc = doc
		
		vscode.workspace.onDidChangeTextDocument(async(e) => {
			console.log(e.document.getText())
			if(e.document !== this.doc) {
				return
			}
			if(e.contentChanges.length == 0){
				return
			}
			for(let i = 0; i < this.offsets.length; i++) {
				let offset = this.offsets[i]
				for(const cc of e.contentChanges) {
					const offset1 = offsetPos(this.doc, offset, cc)
					if(!offset1){
						offset = -1
						break
					} else {
						offset = offset1
					}
				}
				this.offsets[i] = this.normalizeOffset(offset)
			}
			this.offsets = this.offsets.filter(i => i >= 0)
			await this.updateOutput()
		})
	}
	
	dispose(): void {
		const provider = getReconstructionContentProvider()
		const uri = makeUri(docTrackerAuthority, docTrackerPath)
		provider.updateContents(uri, undefined)
		this.decos?.dispose()
		this.decos = undefined
		this.clearSliceDecos()
	}
	
	togglePosition(pos: vscode.Position): boolean {
		const offset = this.normalizeOffset(pos)
		if(offset < 0){
			return false
		}
		const idx = this.offsets.indexOf(offset)
		if(idx >= 0){
			this.offsets.splice(idx, 1)
		} else {
			this.offsets.push(offset)
		}
		return true
	}
	
	normalizeOffset(offsetOrPos: number | vscode.Position): number {
		if(typeof offsetOrPos === 'number'){
			offsetOrPos = this.doc.positionAt(offsetOrPos)
		}
		const range = getPositionAt(offsetOrPos, this.doc)
		if(!range){
			return -1
		}
		return this.doc.offsetAt(range.start)
	}
	
	async updateOutput(): Promise<void> {
		const provider = getReconstructionContentProvider()
		this.updateTargetDecos()
		const code = await this.updateSlices() || '# No slice'
		this.updateTargetDecos()
		const uri = this.makeUri()
		provider.updateContents(uri, code)
	}
	
	makeUri(): vscode.Uri {
		const docPath = path.join(this.doc.uri.path, docTrackerPath)
		return makeUri(docTrackerAuthority, docPath)
	}
	
	updateTargetDecos(): void {
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
				this.decos ||= makeSliceDecorationTypes()
				editor.setDecorations(this.decos.trackedPos, ranges)
			}
		}
	}
	
	async updateSlices(): Promise<string | undefined> {
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
				this.decos ||= makeSliceDecorationTypes()
				void displaySlice(editor, sliceElements, this.decos)
			}
		}
		return code
	}
	
	clearSliceDecos(): void {
		this.decos?.dispose()
		this.decos = undefined
	}
}

function offsetPos(doc: vscode.TextDocument, offset: number, cc: vscode.TextDocumentContentChangeEvent): number | undefined {
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
