import * as net from 'net'
import * as vscode from 'vscode'
import type { FlowrMessage } from '@eagleoutice/flowr/cli/repl'
import type { FileAnalysisResponseMessageJson } from '@eagleoutice/flowr/cli/repl/server/messages/analysis'
import type { SliceResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/slice'
import type { NodeId} from '@eagleoutice/flowr'
import { visitAst } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { isNotUndefined } from '@eagleoutice/flowr/util/assert'
import { FlowrInternalSession } from './internal-session'
import { establishInternalSession, getConfig, isVerbose, updateStatusBar } from '../extension'
import type { FlowrHelloResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/hello'
import { Settings } from '../settings'
import { displaySlice } from '../slice'

export class FlowrServerSession {

	public state:        'inactive' | 'connecting' | 'connected' | 'not connected'
	public flowrVersion: string | undefined
	public rVersion:     string | undefined

	private readonly outputChannel: vscode.OutputChannel
	private socket:                 net.Socket | undefined
	private idCounter = 0

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel

		this.state = 'inactive'
		updateStatusBar()
	}

	initialize() {
		this.state = 'connecting'
		updateStatusBar()

		// the first response will be flowR's hello message
		void this.awaitResponse().then(r => {
			const info = JSON.parse(r) as FlowrHelloResponseMessage
			this.rVersion = info.versions.r
			this.flowrVersion = info.versions.flowr
			updateStatusBar()
		})

		const host = getConfig().get<string>(Settings.ServerHost, 'localhost')
		const port = getConfig().get<number>(Settings.ServerPort, 1042)
		this.outputChannel.appendLine(`Connecting to flowR server at ${host}:${port}`)
		this.socket = net.createConnection(port, host, () => {
			this.state = 'connected'
			updateStatusBar()
			this.outputChannel.appendLine('Connected to flowR server')
		})
		this.socket.on('error', e => {
			this.outputChannel.appendLine(`flowR server error: ${e.message}`)

			const useLocal = 'Use local shell instead'
			const openSettings = 'Open connection settings'
			void vscode.window.showErrorMessage(`The flowR server connection reported an error: ${e.message}`, openSettings, useLocal)
				.then(v => {
					if(v === useLocal) {
						void establishInternalSession()
					} else if(v === openSettings) {
						void vscode.commands.executeCommand( 'workbench.action.openSettings', 'vscode-flowr.server' )
					}
				})
		})
		this.socket.on('close', () => {
			this.outputChannel.appendLine('flowR server connection closed')
			this.state = 'not connected'
			updateStatusBar()
		})
		this.socket.on('data', str => this.handleResponse(String(str)))
	}

	public destroy(): void {
		this.socket?.destroy()
	}

	private currentMessageBuffer = ''
	handleResponse(message: string): void {
		if(!message.endsWith('\n')) {
			this.currentMessageBuffer += message
			return
		}
		message = this.currentMessageBuffer + message
		this.currentMessageBuffer = ''
		if(isVerbose()) {
			this.outputChannel.appendLine('Received: ' + message)
		}
		this.onceOnLineReceived?.(message)
		this.onceOnLineReceived = undefined
	}

	private onceOnLineReceived: undefined | ((line: string) => void)

	sendCommand(command: object): boolean {
		if(this.socket) {
			if(isVerbose()) {
				this.outputChannel.appendLine('Sending: ' + JSON.stringify(command))
			}
			this.socket.write(JSON.stringify(command) + '\n')
			return true
		}
		return false
	}

	async sendCommandWithResponse<Target>(command: FlowrMessage): Promise<Target> {
		const response = this.awaitResponse()
		this.sendCommand(command)
		return JSON.parse(await response) as Target
	}

	awaitResponse(): Promise<string> {
		return new Promise(resolve => {
			this.onceOnLineReceived = resolve
		})
	}

	async retrieveSlice(pos: vscode.Position, editor: vscode.TextEditor, display: boolean): Promise<string> {
		const filename = editor.document.fileName
		const content = FlowrInternalSession.fixEncoding(editor.document.getText())

		const range = FlowrInternalSession.getPositionAt(pos, editor.document)
		pos = range?.start ?? pos

		const response = await this.sendCommandWithResponse<FileAnalysisResponseMessageJson>({
			type:      'request-file-analysis',
			id:        String(this.idCounter++),
			filename,
			format:    'json',
			filetoken: '@tmp',
			content
		})

		// now we want to collect all ids from response in a map again (id -> location)
		const idToLocation = new Map<NodeId, SourceRange>()
		visitAst(response.results.normalize.ast, n => {
			if(n.location) {
				idToLocation.set(n.info.id, n.location)
			}
		})

		const sliceResponse = await this.sendCommandWithResponse<SliceResponseMessage>({
			'type':      'request-slice',
			'id':        String(this.idCounter++),
			'filetoken': '@tmp',
			'criterion': [FlowrInternalSession.toSlicingCriterion(pos)]
		})
		const sliceElements = [...sliceResponse.results.slice.result].map(id => ({ id, location: idToLocation.get(id) }))
			.filter(e => isNotUndefined(e.location)) as { id: NodeId, location: SourceRange; }[]
		// sort by start
		sliceElements.sort((a: { location: SourceRange; }, b: { location: SourceRange; }) => {
			return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column
		})

		if(display) {
			void displaySlice(editor, sliceElements)
		}
		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...sliceResponse.results.slice.result]))
		}
		return sliceResponse.results.reconstruct.code
	}
}
