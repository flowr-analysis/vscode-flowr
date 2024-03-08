import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

export let flowrSession: FlowrInternalSession | FlowrServerSession
export let outputChannel: vscode.OutputChannel
export let diagnostics: vscode.DiagnosticCollection

let serverStatus: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')
	diagnostics = vscode.languages.createDiagnosticCollection('flowR')

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

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.report', () => {
		void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/flowr/issues/new/choose'))
	}))

	serverStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(serverStatus)
	updateServerStatus()

	context.subscriptions.push(new vscode.Disposable(() => flowrSession.destroy()))
	process.on('SIGINT', () => flowrSession.destroy())

	if(getConfig().get<boolean>('server.autoConnect')) {
		establishServerSession()
	} else {
		establishInternalSession()
	}
}

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscode-flowr')
}

export function isVerbose(): boolean {
	return getConfig().get<boolean>('verboseLog', false)
}

export function establishInternalSession() {
	flowrSession?.destroy()
	flowrSession = new FlowrInternalSession(outputChannel, diagnostics)
	updateServerStatus()
}

export function establishServerSession() {
	flowrSession?.destroy()
	flowrSession = new FlowrServerSession(outputChannel, diagnostics)
	updateServerStatus()
}

export function updateServerStatus() {
	if(flowrSession instanceof FlowrServerSession) {
		serverStatus.show()
		serverStatus.text = `$(server) flowR ${flowrSession.state}`
	} else {
		serverStatus.hide()
	}
}
