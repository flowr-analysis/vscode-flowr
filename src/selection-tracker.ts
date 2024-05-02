

import * as vscode from 'vscode'
import { getConfig, getFlowrSession } from './extension'
import { flowrScheme, makeUri, getReconstructionContentProvider, showUri } from './doc-provider'
import type { SliceReturn } from './flowr/utils'
import type { DecoTypes } from './slice'
import { displaySlice, makeSliceDecorationTypes } from './slice'
import { docTrackers } from './doc-tracker'


const selectionTrackerAuthority = 'selection-tracker'
const selectionTrackerPath = 'Selection Slice'


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
	return await showUri(uri)
}


class SelectionSlicer {
	changeListeners: vscode.Disposable[] = []
	
	hasDoc: boolean = false
	
	decos: DecoTypes | undefined
	
	decoratedEditors: vscode.TextEditor[] = []
	
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
		this.clearSliceDecos()
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
		const clearOtherDecos = getConfig().get<boolean>('style.onlyHighlightActiveSelection', false)
		for(const editor of this.decoratedEditors){
			if(editor === ret.editor){
				continue
			}
			if(clearOtherDecos || docTrackers.has(editor.document)){
				this.clearSliceDecos(editor)
			}
		}
		this.decos ||= makeSliceDecorationTypes()
		await displaySlice(ret.editor, ret.sliceElements, this.decos)
		this.decoratedEditors.push(ret.editor)
	}
	
	clearSliceDecos(editor?: vscode.TextEditor, doc?: vscode.TextDocument): void {
		if(!this.decos){
			return
		}
		if(editor){
			editor.setDecorations(this.decos.lineSlice, [])
			editor.setDecorations(this.decos.tokenSlice, [])
			return
		}
		if(doc){
			for(const editor of vscode.window.visibleTextEditors){
				if(editor.document === doc){
					this.clearSliceDecos(editor)
				}
			}
			return
		}
		this.decos?.dispose()
		this.decos = undefined
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
	if(docTrackers.has(editor.document)){
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
