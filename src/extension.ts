import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'
import { Settings } from './settings'
import { registerSliceCommands } from './slice'
import { registerDiagramCommands } from './diagram'
import type { FlowrSession } from './flowr/utils'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

let outputChannel: vscode.OutputChannel

export async function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')

	registerDiagramCommands(context)
	registerSliceCommands(context)

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', async() => {
		await establishServerSession()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession()
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.report', () => {
		void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/flowr/issues/new/choose'))
	}))

	flowrStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(flowrStatus)
	updateStatusBar()

	context.subscriptions.push(new vscode.Disposable(() => destroySession()))
	process.on('SIGINT', () => destroySession())

	if(getConfig().get<boolean>(Settings.ServerAutoConnect)) {
		await establishServerSession()
	}
}


export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Settings.Category)
}

export function isVerbose(): boolean {
	return getConfig().get<boolean>(Settings.VerboseLog, false)
}

export async function establishInternalSession() {
	destroySession()
	flowrSession = new FlowrInternalSession(outputChannel)
	await flowrSession.initialize()
}

let flowrSession: FlowrSession | undefined
export async function getFlowrSession() {
	if(flowrSession){
		return flowrSession
	}
	flowrSession = new FlowrInternalSession(outputChannel)
	await flowrSession.initialize()
	return flowrSession
}

export async function establishServerSession() {
	destroySession()
	flowrSession = new FlowrServerSession(outputChannel)
	await flowrSession.initialize()
}

export function destroySession() {
	flowrSession?.destroy()
	flowrSession = undefined
}

let flowrStatus: vscode.StatusBarItem
export function updateStatusBar() {
	if(flowrSession instanceof FlowrServerSession) {
		flowrStatus.show()
		flowrStatus.text = `$(cloud) flowR server ${flowrSession.state}`
		flowrStatus.tooltip = flowrSession.state === 'connected' ?
			`R version ${flowrSession.rVersion}\nflowR version ${flowrSession.flowrVersion}` : undefined
	} else if(flowrSession instanceof FlowrInternalSession) {
		flowrStatus.show()
		flowrStatus.text = `$(console) flowR shell ${flowrSession.state}`
		flowrStatus.tooltip = flowrSession.state === 'active' ?
			`R version ${flowrSession.rVersion}` : undefined
	} else {
		flowrStatus.hide()
	}
}
