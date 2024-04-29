import * as vscode from 'vscode'
import type { NodeId, RShellOptions, SingleSlicingCriterion } from '@eagleoutice/flowr'
import { LAST_STEP, requestFromInput, RShell, SteppingSlicer } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { isNotUndefined } from '@eagleoutice/flowr/util/assert'
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, getConfig, isVerbose, updateStatusBar } from '../extension'
import { Settings } from '../settings'
import { displaySlice } from '../slice'
import { dataflowGraphToMermaid } from '@eagleoutice/flowr/core/print/dataflow-printer'
import { extractCFG } from '@eagleoutice/flowr/util/cfg/cfg'
import { cfgToMermaid, normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid'

export class FlowrInternalSession {

	public state:    'inactive' | 'loading' | 'active' | 'failure'
	public rVersion: string | undefined

	private readonly outputChannel: vscode.OutputChannel
	private shell:                  RShell | undefined

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel

		this.state = 'inactive'
		updateStatusBar()
	}

	async initialize() {
		this.state = 'loading'
		updateStatusBar()

		this.outputChannel.appendLine('Starting flowR shell')

		let options: Partial<RShellOptions> = {
			revive:      'always',
			sessionName: 'flowr - vscode'
		}
		const executable = getConfig().get<string>(Settings.Rexecutable)?.trim()
		if(executable !== undefined && executable.length > 0) {
			options = { ...options, pathToRExecutable: executable }
		}
		this.outputChannel.appendLine(`Using options ${JSON.stringify(options)}`)

		this.shell = new RShell(options)
		this.shell.tryToInjectHomeLibPath()

		// wait at most 1 second for the version, since the R shell doesn't let us know if the path
		// we provided doesn't actually lead anywhere, or doesn't contain an R executable, etc.
		let handle: NodeJS.Timeout
		const timeout = new Promise<null>(resolve => handle = setTimeout(() => resolve(null), 1000))
		await Promise.race([this.shell.usedRVersion(), timeout]).then(version => {
			clearTimeout(handle)
			if(!version){
				const seeDoc = 'See documentation'
				void vscode.window.showErrorMessage('The R version could not be determined. R needs to be installed and part of your PATH environment variable.', seeDoc)
					.then(s => {
						if(s === seeDoc){
							void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/vscode-flowr/blob/main/README.md#using'))
						}
					})

				this.state = 'failure'
				updateStatusBar()
			} else {
				this.outputChannel.appendLine(`Using R version ${version.toString()}`)
				if(version.major < MINIMUM_R_MAJOR) {
					void vscode.window.showErrorMessage(`You are using R version ${version.toString()}, but ${MINIMUM_R_MAJOR}.0.0 or higher is required.`)
				} else if(version.major < BEST_R_MAJOR) {
					void vscode.window.showWarningMessage(`You are using R version ${version.toString()}, which flowR has not been tested for. Version ${BEST_R_MAJOR}.0.0 or higher is recommended.`)
				}

				this.state = 'active'
				this.rVersion = version.toString()
				updateStatusBar()
			}
		})
	}

	public destroy(): void {
		this.shell?.close()
	}

	async retrieveSlice(pos: vscode.Position, editor: vscode.TextEditor, display: boolean): Promise<string> {
		if(!this.shell) {
			return ''
		}
		try {
			return await this.extractSlice(this.shell, editor, pos, display)
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l))
			void vscode.window.showErrorMessage(`There was an error while extracting a slice: ${(e as Error)?.message}. See the flowR output for more information.`)
			return ''
		}
	}

	async retrieveDataflowMermaid(editor: vscode.TextEditor): Promise<string> {
		if(!this.shell) {
			return ''
		}
		const result = await new SteppingSlicer({
			stepOfInterest: 'dataflow',
			shell:          this.shell,
			request:        requestFromInput(FlowrInternalSession.consolidateNewlines(editor.document.getText()))
		}).allRemainingSteps()
		return dataflowGraphToMermaid(result.dataflow, result.normalize.idMap)
	}

	async retrieveAstMermaid(editor: vscode.TextEditor): Promise<string> {
		if(!this.shell) {
			return ''
		}
		const result = await new SteppingSlicer({
			stepOfInterest: 'normalize',
			shell:          this.shell,
			request:        requestFromInput(FlowrInternalSession.consolidateNewlines(editor.document.getText()))
		}).allRemainingSteps()
		return normalizedAstToMermaid(result.normalize.ast)
	}

	async retrieveCfgMermaid(editor: vscode.TextEditor): Promise<string> {
		if(!this.shell) {
			return ''
		}
		const result = await new SteppingSlicer({
			stepOfInterest: 'normalize',
			shell:          this.shell,
			request:        requestFromInput(FlowrInternalSession.consolidateNewlines(editor.document.getText()))
		}).allRemainingSteps()
		return cfgToMermaid(extractCFG(result.normalize), result.normalize)
	}

	private async extractSlice(shell: RShell, editor: vscode.TextEditor, pos: vscode.Position, display: boolean): Promise<string> {
		const filename = editor.document.fileName
		const content = FlowrInternalSession.consolidateNewlines(editor.document.getText())

		const range = FlowrInternalSession.getPositionAt(pos, editor.document)
		pos = range?.start ?? pos

		if(isVerbose()) {
			this.outputChannel.appendLine(`Extracting slice at ${pos.line + 1}:${pos.character + 1} in ${filename}`)
			this.outputChannel.appendLine(`Token: ${editor.document.getText(range)}`)
		}

		const slicer = new SteppingSlicer({
			criterion:      [FlowrInternalSession.toSlicingCriterion(pos)],
			filename,
			shell,
			request:        requestFromInput(content),
			stepOfInterest: LAST_STEP
		})
		const result = await slicer.allRemainingSteps()

		// we should be more robust here
		const sliceElements = [...result.slice.result]
			.map(id => ({ id, location: result.normalize.idMap.get(id)?.location }))
			.filter(e => isNotUndefined(e.location)) as { id: NodeId, location: SourceRange }[]
		// sort by start
		sliceElements.sort((a: { location: SourceRange }, b: { location: SourceRange }) => {
			return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column
		})

		if(display) {
			void displaySlice(editor, sliceElements)
		}
		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...result.slice.result]))
		}
		return result.reconstruct.code
	}

	public static getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
		const re = /([a-zA-Z0-9._:])+/
		const wordRange = document.getWordRangeAtPosition(position, re)
		return wordRange
	}

	public static consolidateNewlines(text: string) {
		return text.replace(/\r\n/g, '\n')
	}

	public static toSlicingCriterion(pos: vscode.Position): SingleSlicingCriterion {
		return `${pos.line + 1}:${pos.character + 1}`
	}
}
