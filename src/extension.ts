import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'

export let flowrSession: FlowrInternalSession | FlowrServerSession
export let outputChannel: vscode.OutputChannel
export let diagnostics: vscode.DiagnosticCollection

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')
	diagnostics = vscode.languages.createDiagnosticCollection('flowR')

	if(getConfig().get<boolean>('server.autoConnect')) {
		establishServerSession()
	} else {
		establishInternalSession()
	}

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
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor-reconstruct', async() => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor) {
			const code = await flowrSession?.retrieveSlice(activeEditor.selection.active, activeEditor.document)
			const doc =	await vscode.workspace.openTextDocument({language: 'r', content: code})
			void vscode.window.showTextDocument(doc)
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', () => {
		establishServerSession()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			establishInternalSession()
		}
	}))

	context.subscriptions.push(new vscode.Disposable(() => flowrSession.destroy()))
	process.on('SIGINT', () => flowrSession.destroy())
}

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscode-flowr')
}

export function establishInternalSession() {
	flowrSession?.destroy()
	flowrSession = new FlowrInternalSession(outputChannel, diagnostics)
}

export function establishServerSession() {
	flowrSession?.destroy()
	flowrSession = new FlowrServerSession(outputChannel, diagnostics)
}
