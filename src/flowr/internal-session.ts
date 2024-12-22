import { BEST_R_MAJOR, MINIMUM_R_MAJOR, getConfig, isVerbose, updateStatusBar } from '../extension'
import { Settings } from '../settings'
import { dataflowGraphToMermaid } from '@eagleoutice/flowr/core/print/dataflow-printer'
import { extractCFG } from '@eagleoutice/flowr/util/cfg/cfg'
import type { FlowrSession, SliceReturn } from './utils'
import { consolidateNewlines, makeSliceElements, makeSlicingCriteria } from './utils'
import type { RShellOptions } from '@eagleoutice/flowr/r-bridge/shell'
import { RShell, RShellReviveOptions } from '@eagleoutice/flowr/r-bridge/shell'
import { PipelineExecutor } from '@eagleoutice/flowr/core/pipeline-executor'
import { DEFAULT_DATAFLOW_PIPELINE, DEFAULT_NORMALIZE_PIPELINE, DEFAULT_SLICING_PIPELINE } from '@eagleoutice/flowr/core/steps/pipeline/default-pipelines'
import { requestFromInput } from '@eagleoutice/flowr/r-bridge/retriever'
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast'
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg'
import vscode from 'vscode'

export class FlowrInternalSession implements FlowrSession {

	public state:    'inactive' | 'loading' | 'active' | 'failure'
	public rVersion: string | undefined
	public	working:  boolean = false

	private readonly outputChannel: vscode.OutputChannel
	private shell:                  RShell | undefined

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel

		this.state = 'inactive'
		updateStatusBar()
	}

	private async workingOnSlice<T = void>(shell: RShell, fun: (shell: RShell) => Promise<T>): Promise<T> {
		try {
			this.setWorking(true)
			return fun(shell)
		} finally {
			this.setWorking(false)
		}
	}

	setWorking(working: boolean): void {
		this.working = working
		updateStatusBar()
	}

	async initialize() {
		this.state = 'loading'
		updateStatusBar()

		this.outputChannel.appendLine('Starting flowR shell')

		let options: Partial<RShellOptions> = {
			revive:      RShellReviveOptions.Always,
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
							void vscode.env.openExternal(vscode.Uri.parse('https://github.com/flowr-analysis/vscode-flowr/blob/main/README.md#using'))
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

	async retrieveSlice(positions: vscode.Position[], document: vscode.TextDocument, showErrorMessage: boolean = true): Promise<SliceReturn> {
		if(!this.shell) {
			return {
				code:          '',
				sliceElements: []
			}
		}
		try {
			return await this.workingOnSlice(this.shell, async s => await this.extractSlice(s, document, positions))
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l))
			if(showErrorMessage){
				void vscode.window.showErrorMessage(`There was an error while extracting a slice: ${(e as Error)?.message}. See the flowR output for more information.`)
			}
			return {
				code:          '',
				sliceElements: []
			}
		}
	}

	async retrieveDataflowMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.shell) {
			return ''
		}
		return await this.workingOnSlice(this.shell, async s => {
			const result = await new PipelineExecutor(DEFAULT_DATAFLOW_PIPELINE,{
				shell:   s,
				request: requestFromInput(consolidateNewlines(document.getText()))
			}).allRemainingSteps()
			return dataflowGraphToMermaid(result.dataflow)
		})
	}

	async retrieveAstMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.shell) {
			return ''
		}

		return await this.workingOnSlice(this.shell, async s => {
			const result = await new PipelineExecutor(DEFAULT_NORMALIZE_PIPELINE, {
				shell:   s,
				request: requestFromInput(consolidateNewlines(document.getText()))
			}).allRemainingSteps()
			return normalizedAstToMermaid(result.normalize.ast)
		})
	}

	async retrieveCfgMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.shell) {
			return ''
		}

		return await this.workingOnSlice(this.shell, async s => {
			const result = await new PipelineExecutor(DEFAULT_NORMALIZE_PIPELINE, {
				shell:   s,
				request: requestFromInput(consolidateNewlines(document.getText()))
			}).allRemainingSteps()
			return cfgToMermaid(extractCFG(result.normalize), result.normalize)
		})
	}

	private async extractSlice(shell: RShell, document: vscode.TextDocument, positions: vscode.Position[]): Promise<SliceReturn> {
		const content = consolidateNewlines(document.getText())

		const criteria = makeSlicingCriteria(positions, document, isVerbose())

		const slicer = new PipelineExecutor(DEFAULT_SLICING_PIPELINE, {
			criterion: criteria,
			shell,
			request:   requestFromInput(content)
		})
		const result = await slicer.allRemainingSteps()

		const sliceElements = makeSliceElements(result.slice.result, id => result.normalize.idMap.get(id)?.location)

		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...result.slice.result]))
		}
		return {
			code: result.reconstruct.code,
			sliceElements
		}
	}
}
