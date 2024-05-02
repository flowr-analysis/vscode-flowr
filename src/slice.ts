import * as vscode from 'vscode'
import { type NodeId } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { getConfig } from './extension'
import type { SliceDisplay } from './settings'
import { Settings } from './settings'
import { getSelectionSlicer, showSelectionSliceInEditor } from './selection-slicer'
import { disposeActivePositionSlicer, getActivePositionSlicer, addCurrentPositions, positionSlicers } from './position-slicer'

export function registerSliceCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', async() => {
		await getSelectionSlicer().sliceSelectionOnce()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		clearSliceOutput()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.follow.cursor', async() => {
		await getSelectionSlicer().toggleFollowSelection()
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.show.in.editor', async() => {
		await showReconstructionInEditor()
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.position', async() => {
		await addCurrentPositions()
	}))

	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(`${Settings.Category}`)) {
			const selSlicer = getSelectionSlicer()
			selSlicer.clearSliceDecos()
			for(const [, positionSlicer] of positionSlicers){
				void positionSlicer.updateOutput(true)
			}
		}
	})
}

async function showReconstructionInEditor(): Promise<vscode.TextEditor | undefined> {
	const positionSlicer = getActivePositionSlicer()
	if(positionSlicer){
		return await positionSlicer.showReconstruction()
	}
	return await showSelectionSliceInEditor()
}

function clearSliceOutput(): void {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const clearedPositionSlicer = disposeActivePositionSlicer()
	if(clearedPositionSlicer){
		return
	}
	const slicer = getSelectionSlicer()
	slicer.clearSelectionSlice()
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

export interface DecoTypes {
	lineSlice:  vscode.TextEditorDecorationType
	tokenSlice: vscode.TextEditorDecorationType
	slicedPos:  vscode.TextEditorDecorationType
	dispose(): void
}
export function makeSliceDecorationTypes(): DecoTypes {
	const ret: DecoTypes = {
		lineSlice: vscode.window.createTextEditorDecorationType({
			opacity: getConfig().get<number>(Settings.StyleSliceOpacity)?.toString()
		}),
		tokenSlice: vscode.window.createTextEditorDecorationType({
			backgroundColor: 'green',
		}),
		slicedPos: vscode.window.createTextEditorDecorationType({
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
			this.slicedPos.dispose()
		}
	}
	return ret
}
