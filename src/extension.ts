import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'
import { Settings } from './settings'
import { registerSliceCommands } from './slice'
import { registerDiagramCommands } from './diagram'
import type { FlowrSession } from './flowr/utils'
import { selectionSlicer } from './selection-slicer'
import { positionSlicers } from './position-slicer'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

let outputChannel: vscode.OutputChannel
let sessionStatus: vscode.StatusBarItem
let slicingStatus: vscode.StatusBarItem
let flowrSession: FlowrSession | undefined

export async function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')

	registerDiagramCommands(context)
	registerSliceCommands(context)

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.internal', async() => {
		await establishInternalSession()
		return flowrSession
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', async() => {
		await establishServerSession()
		return flowrSession
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession()
		}
	}))

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-flowr.report', () => {
			void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/flowr/issues/new/choose'))
		})
	)

	sessionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(sessionStatus)
	updateSessionStatusBar()

	slicingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
	context.subscriptions.push(slicingStatus)
	updateSlicingStatusBar()

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
	return flowrSession
}
export async function getFlowrSession() {
	if(flowrSession) {
		return flowrSession
	}
	return await establishInternalSession()
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

export function updateSessionStatusBar() {
	if(flowrSession instanceof FlowrServerSession) {
		sessionStatus.show()
		sessionStatus.text = `$(cloud) flowR server ${flowrSession.state}`
		sessionStatus.tooltip =
			flowrSession.state === 'connected'
				? `R version ${flowrSession.rVersion}\nflowR version ${flowrSession.flowrVersion}`
				: undefined
	} else if(flowrSession instanceof FlowrInternalSession) {
		sessionStatus.show()
		sessionStatus.text = `$(console) flowR shell ${flowrSession.state}`
		sessionStatus.tooltip = flowrSession.state === 'active' ? `R version ${flowrSession.rVersion}` : undefined
	} else {
		sessionStatus.hide()
	}
}

export function updateSlicingStatusBar() {
	let text = ''
	const slicingFiles = []

	if(selectionSlicer?.changeListeners.length) {
		text += 'Slicing at cursor'
	}

	if(positionSlicers.size) {
		text += text ? ', positions' : 'Slicing at positions'
		for(const [doc] of positionSlicers) {
			slicingFiles.push(doc.fileName)
		}
	}

	if(text) {
		slicingStatus.show()
		slicingStatus.text = text
		slicingStatus.tooltip = slicingFiles.length ? `Slicing in files\n${slicingFiles.join('\n')}` : undefined
	} else {
		slicingStatus.hide()
	}
}
