// runs only under @vscode/test-web (see src/web/test/suite/index.ts) - the web extension host has no fs/https,
// so this file (and everything it imports) must stay browser-safe: no direct fs/os/child_process usage
import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension } from './test-util';
import { loadedPackagesIn, callBeforeCursor } from '../completion';
import { SigDbTreeDataProvider } from '../flowr/views/sigdb-view';
import { isWeb } from '../extension';

async function openWorkspaceFile(name: string): Promise<vscode.TextEditor> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder, 'expected a workspace folder to be open (see the "example" folder passed to vscode-test-web)');
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, name));
	return vscode.window.showTextDocument(doc);
}

suite('web smoke', () => {
	suiteSetup(async function() {
		// this file is compiled into both the desktop and web test bundles; only run it where it applies
		if(!isWeb()) {
			this.skip();
			return;
		}
		await activateExtension();
	});

	test('the signature database view reports itself unavailable rather than crashing', async() => {
		const provider = new SigDbTreeDataProvider(vscode.window.createOutputChannel('vscode-flowr-test-web-sigdb'));
		const children = await provider.getChildren();
		assert.ok(children.some(c => c.kind === 'info'), `expected an explanatory info node in the web extension, got: ${JSON.stringify(children)}`);
	});

	test('hover and definition providers do not throw for a simple R file (tree-sitter backend)', async() => {
		const editor = await openWorkspaceFile('example.R');
		const pos = new vscode.Position(0, 1); // `sum` in `sum <- 0`
		await assert.doesNotReject(async() => vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos));
		await assert.doesNotReject(async() => vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos));
	});

	test('completion pure-logic helpers behave the same as on desktop', () => {
		assert.deepStrictEqual(loadedPackagesIn('library(dplyr)'), new Set(['dplyr']));
		assert.strictEqual(callBeforeCursor('ggplot(')?.fnName, 'ggplot');
	});
});
