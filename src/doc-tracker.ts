import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { makeUri, getReconstructionContentProvider } from './doc-provider'
import { getPositionAt } from './flowr/utils'
import { displaySlice } from './slice'

let flowrTracker: FlowrTracker | undefined

const docTrackerAuthority = 'doc-tracker'
const docTrackerPath = 'Positions'

export async function trackCurrentPos(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const pos = editor.selection.start
	await trackPos(pos, editor.document)
	await showTrackedSlice()
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

export async function trackPos(pos: vscode.Position, doc: vscode.TextDocument): Promise<boolean> {
	if(!flowrTracker){
		flowrTracker = new FlowrTracker(doc)
	} else if(flowrTracker.doc !== doc){
		flowrTracker.dispose()
		flowrTracker = new FlowrTracker(doc)
	}
	const ret = flowrTracker.togglePosition(pos)
	if(ret){
		await flowrTracker.updateOutput()
	}
	return ret
}

class FlowrTracker {
	listeners: ((e: vscode.Uri) => unknown)[] = []

	doc: vscode.TextDocument

	offsets: number[] = []
	
	deco: vscode.TextEditorDecorationType
	
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
		
		this.deco = vscode.window.createTextEditorDecorationType({
			before: {
				contentText:     '->',
				backgroundColor: 'red'
			}
		})
	}
	
	dispose(): void {
		const provider = getReconstructionContentProvider()
		const uri = makeUri(docTrackerAuthority, docTrackerPath)
		provider.updateContents(uri, undefined)
		this.deco.dispose()
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
		this.updateDecos()
		const code = await this.updateSlices() || '# No slice'
		const uri = makeUri(docTrackerAuthority, docTrackerPath)
		provider.updateContents(uri, code)
	}
	
	updateDecos(): void {
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc){
				const ranges = []
				for(const offset of this.offsets){
					const pos = this.doc.positionAt(offset)
					ranges.push(new vscode.Range(pos, pos))
				}
				editor.setDecorations(this.deco, ranges)
			}
		}
	}
	
	async updateSlices(): Promise<string | undefined> {
		const session = await getFlowrSession()
		const positions = this.offsets.map(offset => this.doc.positionAt(offset))
		if(positions.length === 0){
			return
		}
		const { code, sliceElements } = await session.retrieveSlice(positions, this.doc)
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc) {
				void displaySlice(editor, sliceElements)
			}
		}
		return code
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
