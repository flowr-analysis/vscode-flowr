import * as vscode from 'vscode'
import { type NodeId } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { getConfig } from './extension'
import type { SliceDisplay } from './settings'
import { Settings } from './settings'
import { getSelectionSlicer, showSelectionSliceInEditor } from './selection-tracker'
import { docTrackers, trackCurrentPos } from './doc-tracker'

export let selectionSliceDecoration: vscode.TextEditorDecorationType
export let sliceDecoration: vscode.TextEditorDecorationType
export let sliceCharDeco: vscode.TextEditorDecorationType

export function registerSliceCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', async() => {
		await getSelectionSlicer().sliceSelectionOnce()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		getSelectionSlicer().clearSelectionSlice()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.trackSelection', async() => {
		await getSelectionSlicer().toggleTrackSelection()
	}))
	
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.showSliceInEditor', async() => {
		await showReconstructionInEditor()
	}))
	
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.trackPosition', async() => {
		await trackCurrentPos()
	}))

	recreateSliceDecorationType()
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(`${Settings.Category}.${Settings.StyleSliceOpacity}`)) {
			recreateSliceDecorationType()
		}
	})
	context.subscriptions.push(new vscode.Disposable(() => selectionSliceDecoration.dispose()))
}

async function showReconstructionInEditor(): Promise<vscode.TextEditor | undefined> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const doc = editor.document
	const docTracker = docTrackers.get(doc)
	if(docTracker){
		return await docTracker.showReconstruction()
	}
	return await showSelectionSliceInEditor()
}

export function clearFlowrDecorations(editor?: vscode.TextEditor, onlySelection: boolean = false): void {
	if(editor){
		editor.setDecorations(selectionSliceDecoration, [])
		if(!onlySelection){
			editor.setDecorations(sliceDecoration, [])
			editor.setDecorations(sliceCharDeco, [])
		}
		return
	}
	for(const editor of vscode.window.visibleTextEditors){
		editor.setDecorations(selectionSliceDecoration, [])
		if(!onlySelection){
			editor.setDecorations(sliceDecoration, [])
			editor.setDecorations(sliceCharDeco, [])
		}
	}
}

export async function displaySlice(editor: vscode.TextEditor, sliceElements: { id: NodeId, location: SourceRange }[], decos: DecoTypes) {
	const sliceLines = new Set<number>(sliceElements.map(s => s.location.start.line - 1))
	switch(getConfig().get<SliceDisplay>(Settings.StyleSliceDisplay)) {
		case 'tokens': {
			const ranges = []
			for(const el of sliceElements){
				const range = new vscode.Range(el.location.start.line - 1, el.location.start.column - 1, el.location.end.line - 1, el.location.end.column)
				console.log(editor.document.getText(range))
				ranges.push(range)
			}
			editor.setDecorations(decos.tokenSlice, ranges)
			break
		}
		case 'text': {
			if(sliceLines.size === 0){
				return // do not grey out the entire document
			}
			const decorations: vscode.DecorationOptions[] = []
			for(let i = 0; i < editor.document.lineCount; i++) {
				if(!sliceLines.has(i)) {
					decorations.push({ range: new vscode.Range(i, 0, i, editor.document.lineAt(i).text.length) })
				}
			}
			editor.setDecorations(decos.lineSlice, decorations)
			break
		}
		case 'diff': {
			const sliceContent = []
			for(let i = 0; i < editor.document.lineCount; i++){
				if(!sliceLines.has(i)){
					sliceContent.push(editor.document.lineAt(i).text)
				}
			}
			const sliceDoc = await vscode.workspace.openTextDocument({ language: 'r', content: sliceContent.join('\n') })
			void vscode.commands.executeCommand('vscode.diff', sliceDoc.uri, editor.document.uri)
			break
		}
	}
}

function recreateSliceDecorationType() {
	selectionSliceDecoration?.dispose()
	selectionSliceDecoration = vscode.window.createTextEditorDecorationType({
		opacity: getConfig().get<number>(Settings.StyleSliceOpacity)?.toString()
	})
	sliceDecoration?.dispose()
	sliceDecoration = vscode.window.createTextEditorDecorationType({
		opacity: getConfig().get<number>(Settings.StyleSliceOpacity)?.toString()
	})
	sliceCharDeco?.dispose()
	sliceCharDeco = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'green',
		borderRadius:    '2px'
	})
}

export interface DecoTypes {
	lineSlice:  vscode.TextEditorDecorationType
	tokenSlice: vscode.TextEditorDecorationType
	trackedPos: vscode.TextEditorDecorationType
	dispose(): void
}
export function makeSliceDecorationTypes(): DecoTypes {
	const ret: DecoTypes = {
		lineSlice: vscode.window.createTextEditorDecorationType({
			opacity: getConfig().get<number>(Settings.StyleSliceOpacity)?.toString()
		}),
		tokenSlice: vscode.window.createTextEditorDecorationType({
			backgroundColor: 'green',
			borderRadius:    '2px'
		}),
		trackedPos: vscode.window.createTextEditorDecorationType({
			before: {
				color:           'white',
				contentText:     '->',
				backgroundColor: 'green',
				border:          '2px solid green',
			},
			border: '2px solid green',
		}),
		dispose() {
			this.lineSlice.dispose()
			this.tokenSlice.dispose()
			this.trackedPos.dispose()
		}
	}
	return ret
}
