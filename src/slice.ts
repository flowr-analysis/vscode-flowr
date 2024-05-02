import * as vscode from 'vscode'
import { type NodeId } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { getConfig, getFlowrSession } from './extension'
import type { SliceDisplay } from './settings'
import { Settings } from './settings'
import type { SliceReturn } from './flowr/utils'

export let sliceDecoration: vscode.TextEditorDecorationType
export let sliceCharDeco: vscode.TextEditorDecorationType

export function registerSliceCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', async() => {
		await sliceCursor(true, false)
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor) {
			clearFlowrDecorations(activeEditor)
		}
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor-reconstruct', async() => {
		await sliceCursor(false, true)
	}))

	recreateSliceDecorationType()
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(`${Settings.Category}.${Settings.StyleSliceOpacity}`)) {
			recreateSliceDecorationType()
		}
	})
	context.subscriptions.push(new vscode.Disposable(() => sliceDecoration.dispose()))
}

export function clearFlowrDecorations(editor?: vscode.TextEditor): void {
	if(editor){
		editor.setDecorations(sliceDecoration, [])
		editor.setDecorations(sliceCharDeco, [])
		return
	}
	for(const editor of vscode.window.visibleTextEditors){
		editor.setDecorations(sliceDecoration, [])
		editor.setDecorations(sliceCharDeco, [])
	}
}

async function sliceCursor(display: boolean = true, reconstruct: boolean = false): Promise<SliceReturn | undefined> {
	const activeEditor = vscode.window.activeTextEditor
	if(!activeEditor){
		return undefined
	}
	const positions = activeEditor.selections.map(sel => sel.active)
	const session = await getFlowrSession()
	const { code, sliceElements } = await session.retrieveSlice(positions, activeEditor.document)
	if(display){
		await displaySlice(activeEditor, sliceElements)
	}
	if(reconstruct){
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: code })
		void vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
	}
}

export async function displaySlice(editor: vscode.TextEditor, sliceElements: { id: NodeId, location: SourceRange }[]) {
	const sliceLines = new Set<number>(sliceElements.map(s => s.location.start.line - 1))
	switch(getConfig().get<SliceDisplay>(Settings.StyleSliceDisplay)) {
		case 'tokens': {
			const ranges = []
			for(const el of sliceElements){
				const range = new vscode.Range(el.location.start.line - 1, el.location.start.column - 1, el.location.end.line - 1, el.location.end.column)
				console.log(editor.document.getText(range))
				ranges.push(range)
			}
			const deco = sliceCharDeco
			editor.setDecorations(deco, ranges)
			break
		}
		case 'text': {
			const decorations: vscode.DecorationOptions[] = []
			for(let i = 0; i < editor.document.lineCount; i++) {
				if(!sliceLines.has(i)) {
					decorations.push({ range: new vscode.Range(i, 0, i, editor.document.lineAt(i).text.length) })
				}
			}
			editor.setDecorations(sliceDecoration, decorations)
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
