import * as vscode from 'vscode'
import type { NodeId, RShellOptions, SingleSlicingCriterion} from '@eagleoutice/flowr'
import { LAST_STEP, requestFromInput, RShell, SteppingSlicer } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { isNotUndefined } from '@eagleoutice/flowr/util/assert'
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, getConfig, isVerbose } from '../extension'

export class FlowrInternalSession {
	private readonly outputChannel: vscode.OutputChannel
	private readonly diagnostics:   vscode.DiagnosticCollection
	private readonly shell:         RShell

	constructor(outputChannel: vscode.OutputChannel, collection: vscode.DiagnosticCollection) {
		this.outputChannel = outputChannel
		this.outputChannel.appendLine('Using internal flowR')
		this.diagnostics = collection

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
			} else {
				this.outputChannel.appendLine(`Using R version ${version.toString()}`)
				if(version.major < MINIMUM_R_MAJOR) {
					void vscode.window.showErrorMessage(`You are using R version ${version.toString()}, which is not compatible with flowR.`)
				} else if(version.major < BEST_R_MAJOR) {
					void vscode.window.showWarningMessage(`You are using R version ${version.toString()}, which flowR has not been tested for. Some things might not work correctly.`)
				}
			}
		})
	}

	public destroy(): void {
		this.shell.close()
	}

	async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
		try {
			return await this.extractSlice(this.shell, document, pos)
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l))
			void vscode.window.showErrorMessage(`There was an error while extracting a slice: ${(e as Error)?.message}. See the flowR output for more information.`)
			return ''
		}
	}

	clearSlice(document: vscode.TextDocument) {
		this.diagnostics.delete(document.uri)
	}

	private async extractSlice(shell: RShell, document: vscode.TextDocument, pos: vscode.Position): Promise<string> {
		const filename = document.fileName
		const content = FlowrInternalSession.fixEncoding(document.getText())
		const uri = document.uri

		const range = FlowrInternalSession.getPositionAt(pos, document)
		pos = range?.start ?? pos

		if(isVerbose()) {
			this.outputChannel.appendLine(`Extracting slice at ${pos.line + 1}:${pos.character + 1} in ${filename}`)
			this.outputChannel.appendLine(`Token: ${document.getText(range)}`)
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

		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...result.slice.result]))
		}
		this.diagnostics.set(uri, FlowrInternalSession.createDiagnostics(document, range, pos, sliceElements))
		return result.reconstruct.code
	}

	public static getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
		const re = /([a-zA-Z0-9._:])+/
		const wordRange = document.getWordRangeAtPosition(position, re)
		return wordRange
	}

	public static createDiagnostics(document: vscode.TextDocument, range: vscode.Range | undefined, pos: vscode.Position, sliceElements: { id: NodeId, location: SourceRange }[]): vscode.Diagnostic[]{
		const ret: vscode.Diagnostic[] = []
		const blockedLines = new Set<number>()
		for(const slice of sliceElements) {
			blockedLines.add(slice.location.start.line - 1)
		}
		for(let i = 0; i < document.lineCount; i++) {
			if(blockedLines.has(i)) {
				continue
			}
			ret.push({
				message:  `irrelevant when slicing for '${document.getText(range)}' (line: ${pos.line + 1}, char: ${pos.character + 1})`,
				range:    new vscode.Range(i, 0, i, document.lineAt(i).text.length),
				severity: vscode.DiagnosticSeverity.Hint,
				tags:     [vscode.DiagnosticTag.Unnecessary]
			})
		}
		return ret
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
