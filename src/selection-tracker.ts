

import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { clearFlowrDecorations } from './slice'
import { flowrScheme, makeUri, getReconstructionContentProvider } from './doc-provider'


const selectionTrackerAuthority = 'selection-tracker'
const selectionTrackerPath = 'Selection'


let selectionTracker: SelectionTracker | undefined

export async function trackSelection(): Promise<void> {
	selectionTracker = new SelectionTracker()
	await selectionTracker.update()
}

export function stopTrackSelection(): void {
	selectionTracker?.dispose()
	selectionTracker = undefined
}

export function toggleTrackSelection(): void {
	if(selectionTracker){
		selectionTracker.dispose()
		selectionTracker = undefined
	} else {
		selectionTracker = new SelectionTracker()
		void selectionTracker.update()
	}
}

export async function showSelectionSliceInEditor(): Promise<vscode.TextEditor> {
	if(!selectionTracker){
		await trackSelection()
	}
	const uri = makeUri(selectionTrackerAuthority, selectionTrackerPath)
	const doc = await vscode.workspace.openTextDocument(uri)
	await vscode.languages.setTextDocumentLanguage(doc, 'r')
	return await vscode.window.showTextDocument(doc, {
		viewColumn: vscode.ViewColumn.Beside
	})
}


class SelectionTracker {
	disposables: vscode.Disposable[] = []
	constructor() {
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(() => this.update()),
			vscode.window.onDidChangeActiveTextEditor(() => this.update())
		)
	}
	
	async update(): Promise<void> {
		const code = await updateSelectionSlice()
		if(code === undefined){
			return
		}
		const provider = getReconstructionContentProvider()
		const uri = makeUri(selectionTrackerAuthority, selectionTrackerPath)
		provider.updateContents(uri, code)
	}
	
	dispose(): void {
		for(const dispo of this.disposables){
			dispo.dispose()
		}
		const provider = getReconstructionContentProvider()
		const uri = makeUri(selectionTrackerAuthority, selectionTrackerPath)
		provider.updateContents(uri, undefined)
	}
}


async function updateSelectionSlice(): Promise<string | undefined> {
	const errorCode = '# No slice'
	const editor = vscode.window.activeTextEditor
	if(!editor){
		clearFlowrDecorations()
		return errorCode
	}
	if(editor.document.uri.scheme === flowrScheme){
		return undefined
	}
	const positions = editor.selections.map(sel => sel.active)
	if(!positions.length){
		clearFlowrDecorations(editor)
		return errorCode
	}
	const flowrSession = await getFlowrSession()
	const { code } = await flowrSession.retrieveSlice(positions, editor.document, false)
	if(!code){
		clearFlowrDecorations(editor)
		return errorCode
	}
	return code
}
