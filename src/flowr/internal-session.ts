import * as vscode from 'vscode'
import type { NodeId} from '@eagleoutice/flowr'
import { LAST_STEP, requestFromInput, RShell, SteppingSlicer } from '@eagleoutice/flowr'
import type { SourceRange } from '@eagleoutice/flowr/util/range'
import { isNotUndefined } from '@eagleoutice/flowr/util/assert'

/**
 * Just a proof of concept for now.
 */
export class FlowrInternalSession {
	private readonly outputChannel: vscode.OutputChannel
	private readonly diagnostics:   vscode.DiagnosticCollection
	private readonly shell:         RShell

	constructor(outputChannel: vscode.OutputChannel, collection: vscode.DiagnosticCollection) {
		this.outputChannel = outputChannel
		this.outputChannel.appendLine('Using internal FlowR!')
		this.diagnostics = collection
		this.shell = new RShell({
			revive:      'always',
			sessionName: 'flowr - vscode'
		})
		this.shell.tryToInjectHomeLibPath()
		void this.shell.usedRVersion().then(version => {
			this.outputChannel.appendLine(`Using R shell: ${JSON.stringify(version)}`)
		})
		process.on('exit', () => {
			this.shell.close()
		})
		process.on('SIGINT', () => {
			this.shell.close()
		})
	}

	async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
		try {
			return await this.extractSlice(this.shell, document, pos)
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l))
			return ''
		}
	}

	clearSlice(document: vscode.TextDocument) {
		this.diagnostics.delete(document.uri)
	}

	public static getPositionAt(position: vscode.Position, document: vscode.TextDocument): vscode.Range | undefined {
		const re = /([a-zA-Z0-9._:])+/
		const wordRange = document.getWordRangeAtPosition(position, re)
		return wordRange
	}

	private async extractSlice(shell: RShell, document: vscode.TextDocument, pos: vscode.Position): Promise<string> {
		const filename = document.fileName
		// hacky way to deal with various encodings
		// eslint-disable-next-line no-control-regex
		let content = document.getText().replace(/[^\x00-\x7F]/g,'')
		content = content.replace(/\r\n/g, '\n')
		const uri = document.uri

		const range = FlowrInternalSession.getPositionAt(pos, document)
		pos = range?.start ?? pos
		this.outputChannel.appendLine(`Extracting slice at ${pos.line + 1}:${pos.character + 1} in ${filename}`)
		const token = document.getText(range)
		this.outputChannel.appendLine(`Token: ${token}`)

		const slicer = new SteppingSlicer({
			criterion:      [`${pos.line + 1}:${pos.character + 1}`],
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

		const diagnostics: vscode.Diagnostic[] = []
		const blockedLines = new Set<number>()
		for(const slice of sliceElements) {
			blockedLines.add(slice.location.start.line - 1)
		}
		for(let i = 0; i < document.lineCount; i++) {
			if(blockedLines.has(i)) {
				continue
			}
			diagnostics.push({
				message:  `irrelevant when slicing for '${token}' (line: ${pos.line + 1}, char: ${pos.character + 1})`,
				range:    new vscode.Range(i, 0, i, document.lineAt(i).text.length),
				severity: vscode.DiagnosticSeverity.Hint,
				tags:     [vscode.DiagnosticTag.Unnecessary]
			})
		}
		this.diagnostics.set(uri, diagnostics)
		this.outputChannel.appendLine('slice: ' + JSON.stringify([...result.slice.result]))
		return result.reconstruct.code
	}
}
