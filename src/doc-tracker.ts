import * as vscode from 'vscode'
import { getFlowrSession } from './extension'

let flowrTracker: FlowrTracker | undefined

export async function trackCurrentPos(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const pos = editor.selection.start
	await trackPos(pos, editor.document)
}

export async function trackPos(pos: vscode.Position, doc: vscode.TextDocument): Promise<void> {
	if(!flowrTracker){
		flowrTracker = new FlowrTracker(doc)
	} else if(flowrTracker.doc !== doc){
		flowrTracker.dispose()
		flowrTracker = new FlowrTracker(doc)
	}
	const offset = doc.offsetAt(pos)
	const idx = flowrTracker.offsets.indexOf(offset)
	if(idx >= 0){
		flowrTracker.offsets.splice(idx, 1)
	} else {
		flowrTracker.offsets.push(offset)
	}
	flowrTracker.updateDecos()
	await flowrTracker.updateSlices()
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
				this.offsets[i] = offset
			}
			this.offsets = this.offsets.filter(i => i >= 0)
			this.updateDecos()
			await this.updateSlices()
			
		})
		
		this.deco = vscode.window.createTextEditorDecorationType({
			before: {
				contentText:     '->',
				backgroundColor: 'red'
			}
		})
	}
	
	dispose(): void {
		this.deco.dispose()
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
	
	async updateSlices(): Promise<void> {
		const session = await getFlowrSession()
		const poss = this.offsets.map(offset => this.doc.positionAt(offset))
		if(poss.length === 0){
			return
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc){
				await session.retrieveSlice(poss, editor, true)
				break
			}
		}
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
