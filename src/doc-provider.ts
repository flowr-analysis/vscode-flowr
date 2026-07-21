
// The class in this file is used to provide content for the reconstruction editor
//
// The content of files is updated by us using the .updateContents() method.
//
// The content of a file is requested by vscode using the .provideTextDocumentContent() method,
// when the corresponding URI is opened.
//
// To show a file, use the showUri function, defined below.

import * as vscode from 'vscode';

export const flowrScheme = 'flowr';

export class ReconstructionContentProvider implements vscode.TextDocumentContentProvider {

	listeners: ((e: vscode.Uri) => unknown)[] = [];

	contents: Map<string, string> = new Map();

	onDidChange(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
		this.listeners.push(listener);
		const dispo = new vscode.Disposable(() => {
			this.listeners = this.listeners.filter(l => l !== listener);
		});
		return dispo;
	}

	notifyListeners(uri: vscode.Uri): void {
		for(const listener of this.listeners){
			listener(uri);
		}
	}

	updateContents(uri: vscode.Uri, content?: string) {
		if(content !== undefined){
			this.contents.set(uri.toString(), content);
		} else {
			this.contents.delete(uri.toString());
		}
		this.notifyListeners(uri);
	}

	provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
		return this.contents.get(uri.toString());
	}
}

/**
 *
 */
export function makeUri(authority: string, path: string){
	if(authority && path && !path.startsWith('/')){
		path = '/' + path;
	}
	const uri = vscode.Uri.from({
		scheme:    flowrScheme,
		authority: authority,
		path:      path
	});
	return uri;
}

/**
 * Waits until `doc`'s live buffer actually reflects the content most recently written to the reconstruction
 * provider for its URI. Reusing an already-visible editor (see {@link showUri}) skips `openTextDocument`, whose
 * first read is otherwise what picks up a just-written update synchronously; VS Code instead refetches an
 * already-open virtual document asynchronously in response to `onDidChange`, so without this wait, a caller
 * could observe the previous (possibly stale/empty) content for one more event-loop turn.
 */
async function waitForFreshContent(doc: vscode.TextDocument): Promise<void> {
	const expected = getReconstructionContentProvider().contents.get(doc.uri.toString()) ?? '';
	if(doc.getText() === expected){
		return;
	}
	await new Promise<void>(resolve => {
		const timeout = setTimeout(() => {
			dispo.dispose();
			resolve();
		}, 2000);
		const dispo = vscode.workspace.onDidChangeTextDocument(e => {
			if(e.document === doc && doc.getText() === expected){
				clearTimeout(timeout);
				dispo.dispose();
				resolve();
			}
		});
	});
}

/**
 *
 */
export async function showUri(uri: vscode.Uri, language: string = 'r', viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<Thenable<vscode.TextEditor>> {
	for(const editor of vscode.window.visibleTextEditors){
		if(editor.document.uri.toString() === uri.toString()){
			await waitForFreshContent(editor.document);
			return editor;
		}
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.languages.setTextDocumentLanguage(doc, language);
	// covers a document that is already open (cached from an earlier, now non-visible tab) but not yet showing
	// the latest write - the same async-refetch race as the already-visible branch above
	await waitForFreshContent(doc);
	const editor = await vscode.window.showTextDocument(doc, {
		viewColumn:    viewColumn,
		preserveFocus: true,
		selection:     new vscode.Selection(doc.lineCount - 1, 0, doc.lineCount - 1, 0)
	});
	// scroll to bottom
	const lineCount = editor.document.lineCount;
	const lastLine = editor.document.lineAt(lineCount - 1);
	editor.selection = new vscode.Selection(lastLine.range.end, lastLine.range.end);
	editor.revealRange(lastLine.range, vscode.TextEditorRevealType.Default);
	setTimeout(() => {
		editor.revealRange(lastLine.range, vscode.TextEditorRevealType.Default);
	}, 50);

	return editor;
}

let reconstructionContentProvider: ReconstructionContentProvider | undefined;
/**
 *
 */
export function getReconstructionContentProvider(): ReconstructionContentProvider {
	if(!reconstructionContentProvider) {
		reconstructionContentProvider = new ReconstructionContentProvider();
		vscode.workspace.registerTextDocumentContentProvider(flowrScheme, reconstructionContentProvider);
	}
	return reconstructionContentProvider;
}

