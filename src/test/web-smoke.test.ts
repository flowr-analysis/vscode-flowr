// runs only under @vscode/test-web; this file (and everything it imports) must stay browser-safe - no fs/os/child_process
import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import { loadedPackagesIn, callBeforeCursor } from '../completion';
import { SigDbTreeDataProvider } from '../flowr/views/sigdb-view';
import { isWeb } from '../extension';

suite('web smoke', () => {
	suiteSetup(async function() {
		// this file is compiled into both the desktop and web test bundles; only run it where it applies
		if(!isWeb()) {
			this.skip();
			return;
		}
		await activateExtension();
	});

	test('the signature database view lists real scopes without crashing', async() => {
		const provider = new SigDbTreeDataProvider(vscode.window.createOutputChannel('vscode-flowr-test-web-sigdb'));
		const children = await provider.getChildren();
		assert.ok(children.some(c => c.kind === 'scope'), `expected real scope nodes in the web extension, got: ${JSON.stringify(children)}`);
	});

	// end-to-end over the bundled base scope: virtual-fs hydration, WASM brotli decompression, and flowR's reader all have to work together
	test('the bundled base-R signature scope is really readable in the web build', async function() {
		this.timeout(30000);
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'compiler::cmpfun(1)\n' });
		await vscode.window.showTextDocument(doc, { preview: false });
		const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 12));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		assert.ok(contents.some(v => /provided by/.test(v) && v.includes('compiler')), `expected a hover attributing cmpfun to the base-R package "compiler", got: ${JSON.stringify(contents)}`);
	});

	test('hover and definition providers do not throw for a simple R file (tree-sitter backend)', async() => {
		const editor = await openTestFile('example.R');
		const pos = new vscode.Position(0, 1); // `sum` in `sum <- 0`
		await assert.doesNotReject(async() => vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos));
		await assert.doesNotReject(async() => vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos));
	});

	test('completion pure-logic helpers behave the same as on desktop', () => {
		assert.deepStrictEqual(loadedPackagesIn('library(dplyr)'), new Set(['dplyr']));
		assert.strictEqual(callBeforeCursor('ggplot(')?.fnName, 'ggplot');
	});
});
