import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'
import type { NodeId } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

export let flowrSession: FlowrInternalSession | FlowrServerSession | undefined
export let outputChannel: vscode.OutputChannel
export let sliceDecoration: vscode.TextEditorDecorationType

let serverStatus: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')
	sliceDecoration = vscode.window.createTextEditorDecorationType({
		opacity: getConfig().get<number>('style.sliceOpacity')?.toString()
	})

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', () => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor?.selection) {
			if(!flowrSession) {
				establishInternalSession()
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
				establishInternalSession()
			}
			const code = await flowrSession?.retrieveSlice(activeEditor.selection.active, activeEditor, false)
			const doc =	await vscode.workspace.openTextDocument({language: 'r', content: code})
			void vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', () => {
		establishServerSession()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession()
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.report', () => {
		void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/flowr/issues/new/choose'))
	}))

	serverStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(serverStatus)
	updateServerStatus()

	context.subscriptions.push(new vscode.Disposable(() => destroySession()))
	process.on('SIGINT', () => destroySession())

	if(getConfig().get<boolean>('server.autoConnect')) {
		establishServerSession()
	}
}

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('vscode-flowr')
}

export function isVerbose(): boolean {
	return getConfig().get<boolean>('verboseLog', false)
}

export function establishInternalSession() {
	destroySession()
	flowrSession = new FlowrInternalSession(outputChannel)
	updateServerStatus()
}

export function establishServerSession() {
	destroySession()
	flowrSession = new FlowrServerSession(outputChannel)
	updateServerStatus()
}

export function destroySession() {
	flowrSession?.destroy()
	flowrSession = undefined
}

export function updateServerStatus() {
	if(flowrSession instanceof FlowrServerSession) {
		serverStatus.show()
		serverStatus.text = `$(server) flowR ${flowrSession.state}`
	} else {
		serverStatus.hide()
	}
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
