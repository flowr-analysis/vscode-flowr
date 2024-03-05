import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'

export let flowrSession: FlowrInternalSession

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	const channel = vscode.window.createOutputChannel('flowR')
	const diagnostics = vscode.languages.createDiagnosticCollection('flowR')
	flowrSession = new FlowrInternalSession(channel, diagnostics)

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', () => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor?.selection) {
			void flowrSession?.retrieveSlice(activeEditor.selection.active, activeEditor.document)
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor?.document) {
			void flowrSession?.clearSlice(activeEditor.document)
		}
	}))
}

export function deactivate() {}
