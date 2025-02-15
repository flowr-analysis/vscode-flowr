import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'
import { Settings } from './settings'
import { registerSliceCommands } from './slice'
import { registerDiagramCommands } from './diagram'
import type { FlowrSession } from './flowr/utils'
import { selectionSlicer } from './selection-slicer'
import { positionSlicers } from './position-slicer'
import { flowrVersion } from '@eagleoutice/flowr/util/version'
import type { KnownParserName } from '@eagleoutice/flowr/r-bridge/parser'
import { FlowrDependencyView, registerDependencyView } from './flowr/views/dependency-view'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

let extensionContext: vscode.ExtensionContext
let outputChannel: vscode.OutputChannel
let statusBarItem: vscode.StatusBarItem
let flowrSession: FlowrSession | undefined

export async function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	extensionContext = context
	outputChannel = vscode.window.createOutputChannel('flowR')

	registerDiagramCommands(context, outputChannel)
	registerSliceCommands(context)
	
	registerDependencyView(outputChannel)	

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
			void vscode.env.openExternal(vscode.Uri.parse('https://github.com/flowr-analysis/flowr/issues/new/choose'))
		})
	)

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(statusBarItem)
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

export async function establishInternalSession(forcedEngine?: KnownParserName) {
	destroySession()
	flowrSession = new FlowrInternalSession(outputChannel, forcedEngine)
	await flowrSession.initialize()
	return flowrSession
}
export async function getFlowrSession() {
	if(flowrSession) {
		return flowrSession
	}
	// initialize a default session if none is active
	// on the web, we always want to use the tree-sitter backend since we can't run R
	return await establishInternalSession(isWeb() ? 'tree-sitter' : undefined)
}

export async function establishServerSession() {
	destroySession()
	flowrSession = new FlowrServerSession(outputChannel)
	await flowrSession.initialize()
	return flowrSession
}

export function destroySession() {
	flowrSession?.destroy()
	flowrSession = undefined
}

export function updateStatusBar() {
	const text: string[] = []
	const tooltip: string[] = []

	if(flowrSession instanceof FlowrServerSession) {
		text.push(`$(cloud) flowR ${flowrSession.state}`)
		if(flowrSession.state === 'connected') {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrSession.flowrVersion}`)
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing')
		}
	} else if(flowrSession instanceof FlowrInternalSession) {
		text.push(`$(console) flowR ${flowrSession.state}`)
		if(flowrSession.state === 'active') {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrVersion().toString()}  \nEngine ${flowrSession.parser?.name}`)
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing')
		}
	}

	const slicingTypes: string[] = []
	const slicingFiles: string[] = []
	if(selectionSlicer?.changeListeners.length) {
		slicingTypes.push('cursor')
	}
	if(positionSlicers.size) {
		const pos = [...positionSlicers].reduce((i, [,s]) => i + s.offsets.length, 0)
		if(pos > 0) {
			slicingTypes.push(`${pos} position${pos === 1 ? '' : 's'}`)
			for(const [doc,slicer] of positionSlicers) {
				slicingFiles.push(`${vscode.workspace.asRelativePath(doc.fileName)} (${slicer.offsets.length} position${slicer.offsets.length === 1 ? '' : 's'})`)
			}
		}
	}

	if(slicingTypes.length) {
		text.push(`$(lightbulb) Slicing ${slicingTypes.join(', ')}`)
		if(slicingFiles.length) {
			tooltip.push(`Slicing in\n${slicingFiles.map(f => `- ${f}`).join('\n')}`)
		}
	}

	if(text.length) {
		statusBarItem.show()
		statusBarItem.text = text.join(' ')
		statusBarItem.tooltip = tooltip.length ? tooltip.reduce((m, s) => m.appendMarkdown('\n\n').appendMarkdown(s), new vscode.MarkdownString()) : undefined
	} else {
		statusBarItem.hide()
	}
}

export function isWeb() {
	// apparently there is no official way to test this from the vscode api other
	// than in the command availability context stuff, which is not what we want
	// this is dirty but it should work since the WebSocket is unavailable in node
	return typeof WebSocket !== 'undefined'
}

export function getWasmRootPath(): string {
	if(!isWeb()) {
		return `${__dirname}/flowr/tree-sitter`
	} else {
		const uri = vscode.Uri.joinPath(extensionContext.extensionUri, '/dist/web')
		// in the fake browser version of vscode, it needs to be a special scheme, so we do this check
		return uri.scheme !== 'file' ? uri.toString() : `vscode-file://vscode-app/${uri.fsPath}`
	}
}
