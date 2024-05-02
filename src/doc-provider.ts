
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
	
	// updateUri(uri: vscode.Uri, content: string): void {
	updateContents(uri: vscode.Uri, content?: string) {
		if(content !== undefined){
			this.contents.set(uri.toString(), content)
		} else {
			this.contents.delete(uri.toString())
		}
		this.notifyListeners(uri)
	}

	notifyListeners(uri: vscode.Uri): void {
		for(const listener of this.listeners){
			listener(uri)
		}
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

let reconstructionContentProvider: ReconstructionContentProvider | undefined
export function getReconstructionContentProvider(): ReconstructionContentProvider {
	if(!reconstructionContentProvider) {
		reconstructionContentProvider = new ReconstructionContentProvider()
		vscode.workspace.registerTextDocumentContentProvider(flowrScheme, reconstructionContentProvider)
	}
	return reconstructionContentProvider
}

