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
import { establishInternalSession, getConfig, isVerbose } from '../extension'

export class FlowrServerSession {
	private readonly outputChannel: vscode.OutputChannel
	private readonly diagnostics:   vscode.DiagnosticCollection
	private socket:                 net.Socket
	private idCounter = 0

	constructor(outputChannel: vscode.OutputChannel, diagnostics: vscode.DiagnosticCollection) {
		this.outputChannel = outputChannel

		const host = getConfig().get<string>('server.host', 'localhost')
		const port = getConfig().get<number>('server.port', 1042)
		this.outputChannel.appendLine(`Connecting to flowR server at ${host}:${port}`)
		this.socket = net.createConnection(port, host, () => {
			const msg = 'Connected to flowR server'
			this.outputChannel.appendLine(msg)
			void vscode.window.showInformationMessage(msg)
		})
		this.socket.on('error', e => {
			this.outputChannel.appendLine(`flowR server error: ${e.message}`)

			const useLocal = 'Use local shell instead'
			void vscode.window.showErrorMessage(`The flowR server connection reported an error: ${e.message}`, useLocal)
				.then(v => {
					if(v === useLocal) {
						establishInternalSession()
					}
				})
		})
		this.socket.on('data', str => this.handleResponse(String(str)))

		this.diagnostics = diagnostics
	}

	public destroy(): void {
		this.socket.destroy()
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

	sendCommand(command: object): void {
		if(isVerbose()) {
			this.outputChannel.appendLine('Sending: ' + JSON.stringify(command))
		}
		this.socket.write(JSON.stringify(command) + '\n')
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

	clearSlice(document: vscode.TextDocument) {
		this.diagnostics.delete(document.uri)
	}

	async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
		const filename = document.fileName
		const content = FlowrInternalSession.fixEncoding(document.getText())
		const uri = document.uri

		const range = FlowrInternalSession.getPositionAt(pos, document)
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

		this.diagnostics.set(uri, FlowrInternalSession.createDiagnostics(document, range, pos, sliceElements))
		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...sliceResponse.results.slice.result]))
		}
		return sliceResponse.results.reconstruct.code
	}
}
