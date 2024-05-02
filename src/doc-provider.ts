
import * as vscode from 'vscode'

export const flowrScheme = 'flowr'

export class ReconstructionContentProvider implements vscode.TextDocumentContentProvider {

	listeners: ((e: vscode.Uri) => unknown)[] = []

	contents: Map<string, string> = new Map()

	onDidChange(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
		this.listeners.push(listener)
		const dispo = new vscode.Disposable(() => {
			this.listeners = this.listeners.filter(l => l !== listener)
		})
		return dispo
	}

	notifyListeners(uri: vscode.Uri): void {
		for(const listener of this.listeners){
			listener(uri)
		}
	}

	updateContents(uri: vscode.Uri, content?: string) {
		if(content !== undefined){
			this.contents.set(uri.toString(), content)
		} else {
			this.contents.delete(uri.toString())
		}
		this.notifyListeners(uri)
	}

	provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
		return this.contents.get(uri.toString())
	}
}

export function makeUri(authority: string, path: string){
	if(authority && path && !path.startsWith('/')){
		path = '/' + path
	}
	const uri = vscode.Uri.from({
		scheme:    flowrScheme,
		authority: authority,
		path:      path
	})
	return uri
}

export async function showUri(uri: vscode.Uri): Promise<Thenable<vscode.TextEditor>>
export async function showUri(authority: string, path: string): Promise<Thenable<vscode.TextEditor>>
export async function showUri(uri: vscode.Uri | string, path?: string): Promise<Thenable<vscode.TextEditor>> {
	if(typeof uri === 'string'){
		uri = makeUri(uri, path || '')
	}
	for(const editor of vscode.window.visibleTextEditors){
		if(editor.document.uri.toString() === uri.toString()){
			return editor
		}
	}
	const doc = await vscode.workspace.openTextDocument(uri)
	await vscode.languages.setTextDocumentLanguage(doc, 'r')
	return await vscode.window.showTextDocument(doc, {
		viewColumn: vscode.ViewColumn.Beside
	})
}

let reconstructionContentProvider: ReconstructionContentProvider | undefined
export function getReconstructionContentProvider(): ReconstructionContentProvider {
	if(!reconstructionContentProvider) {
		reconstructionContentProvider = new ReconstructionContentProvider()
		vscode.workspace.registerTextDocumentContentProvider(flowrScheme, reconstructionContentProvider)
	}
	return reconstructionContentProvider
}

