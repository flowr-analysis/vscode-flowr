

import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { flowrScheme, makeUri, getReconstructionContentProvider } from './doc-provider'
import type { SliceReturn } from './flowr/utils'
import { clearFlowrDecorations, displaySlice } from './slice'


const selectionTrackerAuthority = 'selection-tracker'
const selectionTrackerPath = 'Selection'


let selectionTracker: SelectionSlicer | undefined
export function getSelectionSlicer(): SelectionSlicer {
	selectionTracker ||= new SelectionSlicer()
	return selectionTracker
}

export async function showSelectionSliceInEditor(): Promise<vscode.TextEditor> {
	const slicer = getSelectionSlicer()
	if(!slicer.hasDoc){
		await slicer.sliceSelectionOnce()
	}
	const uri = slicer.makeUri()
	const doc = await vscode.workspace.openTextDocument(uri)
	await vscode.languages.setTextDocumentLanguage(doc, 'r')
	return await vscode.window.showTextDocument(doc, {
		viewColumn: vscode.ViewColumn.Beside
	})
}


class SelectionSlicer {
	changeListeners: vscode.Disposable[] = []
	
	hasDoc: boolean = false
	
	async startTrackSelection(): Promise<void> {
		await this.update()
		this.changeListeners.push(
			vscode.window.onDidChangeTextEditorSelection(() => this.update()),
			vscode.window.onDidChangeActiveTextEditor(() => this.update())
		)
	}
	
	async toggleTrackSelection(): Promise<void> {
		if(this.changeListeners.length){
			this.stopTrackSelection()
		} else {
			await this.startTrackSelection()
		}
	}
	
	stopTrackSelection(): void {
		while(this.changeListeners.length){
			this.changeListeners.pop()?.dispose()
		}
	}
	
	async sliceSelectionOnce(): Promise<void> {
		await this.update()
	}
	
	clearSelectionSlice(): void {
		this.stopTrackSelection()
		const provider = getReconstructionContentProvider()
		const uri = this.makeUri()
		provider.updateContents(uri, '')
		clearFlowrDecorations()
		this.hasDoc = false
	}
	
	protected async update(): Promise<void> {
		const ret = await getSelectionSlice()
		if(ret === undefined){
			return
		}
		const provider = getReconstructionContentProvider()
		const uri = this.makeUri()
		provider.updateContents(uri, ret.code)
		this.hasDoc = true
		await displaySlice(ret.editor, ret.sliceElements)
	}
	
	makeUri(): vscode.Uri {
		return makeUri(selectionTrackerAuthority, selectionTrackerPath)
	}
}


interface SelectionSliceReturn extends SliceReturn {
	editor: vscode.TextEditor
}
async function getSelectionSlice(): Promise<SelectionSliceReturn | undefined> {

	const editor = vscode.window.activeTextEditor
	if(!editor){
		return undefined
	}
	if(editor.document.uri.scheme === flowrScheme){
		return undefined
	}
	if(editor.document.languageId.toLowerCase() !== 'r'){
		return undefined
	}
	const positions = editor.selections.map(sel => sel.active)
	if(!positions.length){
		// (should not happen)
		return undefined
	}
	const flowrSession = await getFlowrSession()
	const ret = await flowrSession.retrieveSlice(positions, editor.document, false)
	if(!ret.sliceElements.length){
		return {
			code:          '# No slice',
			sliceElements: [],
			editor:        editor
		}
	}
	return {
		...ret,
		editor
	}
}
