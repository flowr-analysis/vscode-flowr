import * as net from 'net'
import * as vscode from 'vscode'
import type { FlowrMessage } from '@eagleoutice/flowr/cli/repl/server/messages/messages'
import type { FileAnalysisResponseMessageJson } from '@eagleoutice/flowr/cli/repl/server/messages/analysis'
import type { SliceResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/slice'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { establishInternalSession, getConfig, isVerbose, updateStatusBar } from '../extension'
import type { FlowrHelloResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/hello'
import { Settings } from '../settings'
import { dataflowGraphToMermaid } from '@eagleoutice/flowr/core/print/dataflow-printer'
import { extractCFG } from '@eagleoutice/flowr/util/cfg/cfg'
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast'
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg'
import type { FlowrSession, SliceReturn } from './utils'
import { consolidateNewlines, makeSliceElements, makeSlicingCriteria } from './utils'
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id'
import { visitAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/visitor'
import type { DataflowGraphJson } from '@eagleoutice/flowr/dataflow/graph/graph'
import { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph'
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate'
import { BiMap } from '@eagleoutice/flowr/util/bimap'

export class FlowrServerSession implements FlowrSession {

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

	async retrieveDataflowMermaid(document: vscode.TextDocument): Promise<string> {
		const response = await this.requestFileAnalysis(document)
		return dataflowGraphToMermaid({
			...response.results.dataflow,
			graph: DataflowGraph.fromJson(response.results.dataflow.graph as unknown as DataflowGraphJson)
		})
	}

	async retrieveAstMermaid(document: vscode.TextDocument): Promise<string> {
		const response = await this.requestFileAnalysis(document)
		return normalizedAstToMermaid(response.results.normalize.ast)
	}

	async retrieveCfgMermaid(document: vscode.TextDocument): Promise<string> {
		const response = await this.requestFileAnalysis(document)
		const normalize: NormalizedAst = {
			...response.results.normalize,
			idMap: new BiMap()
		}
		return cfgToMermaid(extractCFG(normalize), normalize)
	}

	async retrieveSlice(positions: vscode.Position[], document: vscode.TextDocument): Promise<SliceReturn> {
		const criteria = makeSlicingCriteria(positions, document, isVerbose())

		const response = await this.requestFileAnalysis(document)
		// now we want to collect all ids from response in a map again (id -> location)
		const idToLocation = new Map<NodeId, SourceRange>()
		visitAst(response.results.normalize.ast, n => {
			// backwards compat for server versions before 2.0.2, which used a "flavor" rather than a "named" boolean
			if(n.flavor === 'named') {
				n['name' + 'd'] = true
			}

			if(n.location) {
				idToLocation.set(n.info.id, n.location)
			}
		})

		const sliceResponse = await this.sendCommandWithResponse<SliceResponseMessage>({
			'type':      'request-slice',
			'id':        String(this.idCounter++),
			'filetoken': '@tmp',
			'criterion': criteria
		})

		const sliceElements = makeSliceElements(sliceResponse.results.slice.result, id => idToLocation.get(id))

		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...sliceResponse.results.slice.result]))
		}
		return {
			code: sliceResponse.results.reconstruct.code,
			sliceElements
		}
	}

	private async requestFileAnalysis(document: vscode.TextDocument): Promise<FileAnalysisResponseMessageJson> {
		return await this.sendCommandWithResponse<FileAnalysisResponseMessageJson>({
			type:      'request-file-analysis',
			id:        String(this.idCounter++),
			filename:  document.fileName,
			format:    'json',
			filetoken: '@tmp',
			content:   consolidateNewlines(document.getText())
		})
	}
}
