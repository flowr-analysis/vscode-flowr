import * as vscode from 'vscode'
import type { NodeId, RShellOptions, SingleSlicingCriterion} from '@eagleoutice/flowr'
import { LAST_STEP, requestFromInput, RShell, SteppingSlicer } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { isNotUndefined } from '@eagleoutice/flowr/util/assert'
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, createSliceDecorations, getConfig, isVerbose, sliceDecoration, updateStatusBar } from '../extension'

export class FlowrInternalSession {

	public state:    'loading' | 'active' | 'errored'
	public rVersion: string | undefined

	private readonly outputChannel: vscode.OutputChannel
	private readonly shell:         RShell

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel
		this.outputChannel.appendLine('Using internal flowR')

		this.state = 'loading'
		updateStatusBar()

		let options: Partial<RShellOptions> = {
			revive:      'always',
			sessionName: 'flowr - vscode'
		}
		const executable = getConfig().get<string>('r.executable')?.trim()
		if(executable !== undefined && executable.length > 0) {
			options = {...options, pathToRExecutable: executable }
		}

		this.shell = new RShell(options)
		this.shell.tryToInjectHomeLibPath()

		// wait at most 1 second for the version, since the R shell doesn't let us know if the path
		// we provided doesn't actually lead anywhere, or doesn't contain an R executable, etc.
		let handle: NodeJS.Timeout
		const timeout = new Promise<null>(resolve => handle = setTimeout(() => resolve(null), 1000))
		void Promise.race([this.shell.usedRVersion(), timeout]).then(version => {
			clearTimeout(handle)
			if(!version){
				const seeDoc = 'See documentation'
				void vscode.window.showErrorMessage('The R version could not be determined. R needs to be installed and part of your PATH environment variable.', seeDoc)
					.then(s => {
						if(s === seeDoc){
							void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/vscode-flowr/blob/main/README.md#using'))
						}
					})

				this.state = 'errored'
				updateStatusBar()
			} else {
				this.outputChannel.appendLine(`Using R version ${version.toString()}`)
				if(version.major < MINIMUM_R_MAJOR) {
					void vscode.window.showErrorMessage(`You are using R version ${version.toString()}, which is not compatible with flowR.`)
				} else if(version.major < BEST_R_MAJOR) {
					void vscode.window.showWarningMessage(`You are using R version ${version.toString()}, which flowR has not been tested for. Some things might not work correctly.`)
				}

				this.state = 'active'
				this.rVersion = version.toString()
				updateStatusBar()
			}
		})
	}

	public destroy(): void {
		this.shell.close()
	}

	async retrieveSlice(pos: vscode.Position, editor: vscode.TextEditor, decorate: boolean): Promise<string> {
		try {
			return await this.extractSlice(this.shell, editor, pos, decorate)
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l))
			void vscode.window.showErrorMessage(`There was an error while extracting a slice: ${(e as Error)?.message}. See the flowR output for more information.`)
			return ''
		}
	}

	private async extractSlice(shell: RShell, editor: vscode.TextEditor, pos: vscode.Position, decorate: boolean): Promise<string> {
		const filename = editor.document.fileName
		const content = FlowrInternalSession.fixEncoding(editor.document.getText())

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
			.map(id => ({id, location: result.normalize.idMap.get(id)?.location}))
			.filter(e => isNotUndefined(e.location)) as { id: NodeId, location: SourceRange }[]
		// sort by start
		sliceElements.sort((a: { location: SourceRange }, b: { location: SourceRange }) => {
			return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column
		})

		if(decorate) {
			editor.setDecorations(sliceDecoration, createSliceDecorations(editor.document, sliceElements))
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

	public static fixEncoding(text: string) {
		// hacky way to deal with various encodings
		// eslint-disable-next-line no-control-regex
		let content = text.replace(/[^\x00-\x7F]/g,'')
		content = content.replace(/\r\n/g, '\n')
		return content
	}

	public static toSlicingCriterion(pos: vscode.Position): SingleSlicingCriterion {
		return `${pos.line + 1}:${pos.character + 1}`
	}
}
