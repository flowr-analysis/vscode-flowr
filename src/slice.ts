import * as vscode from 'vscode'
import type { NodeId } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { establishInternalSession, flowrSession, getConfig } from './extension'
import { Settings } from './settings'

export let sliceDecoration: vscode.TextEditorDecorationType

export function registerSliceCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', async() => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor?.selection) {
			if(!flowrSession) {
				await establishInternalSession()
			}
			void flowrSession?.retrieveSlice(activeEditor.selection.active, activeEditor, true)
		}
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor) {
			activeEditor.setDecorations(sliceDecoration, [])
		}
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor-reconstruct', async() => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor) {
			if(!flowrSession) {
				await establishInternalSession()
			}
			const code = await flowrSession?.retrieveSlice(activeEditor.selection.active, activeEditor, false)
			const doc =	await vscode.workspace.openTextDocument({language: 'r', content: code})
			void vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
		}
	}))

	recreateSliceDecorationType()
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(`${Settings.Category}.${Settings.StyleSliceOpacity}`)) {
			recreateSliceDecorationType()
		}
	})
	context.subscriptions.push(new vscode.Disposable(() => sliceDecoration.dispose()))
}

export function createSliceDecorations(document: vscode.TextDocument, sliceElements: { id: NodeId, location: SourceRange }[]): vscode.DecorationOptions[]{
	// create a set to make finding matching lines
	const sliceLines = new Set<number>(sliceElements.map(s => s.location.start.line - 1))
	const ret: vscode.DecorationOptions[] = []
	for(let i = 0; i < document.lineCount; i++) {
		if(!sliceLines.has(i)) {
			ret.push({range: new vscode.Range(i, 0, i, document.lineAt(i).text.length)})
		}
	}
	return ret
}

function recreateSliceDecorationType() {
	sliceDecoration?.dispose()
	sliceDecoration = vscode.window.createTextEditorDecorationType({
		opacity: getConfig().get<number>(Settings.StyleSliceOpacity)?.toString()
	})
}
