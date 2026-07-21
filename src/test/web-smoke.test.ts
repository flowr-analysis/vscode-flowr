// runs only under @vscode/test-web; this file (and everything it imports) must stay browser-safe - no fs/os/child_process
import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension } from './test-util';
import { loadedPackagesIn, callBeforeCursor } from '../completion';
import { SigDbTreeDataProvider } from '../flowr/views/sigdb-view';
import { isWeb } from '../extension';
import { findSigDbPackageSource, getSigDbScopeState, safeSigDbCall } from '../package-db';

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

	test('the signature database view lists real scopes without crashing', async() => {
		const provider = new SigDbTreeDataProvider(vscode.window.createOutputChannel('vscode-flowr-test-web-sigdb'));
		const children = await provider.getChildren();
		assert.ok(children.some(c => c.kind === 'scope'), `expected real scope nodes in the web extension, got: ${JSON.stringify(children)}`);
	});

	// end-to-end over the bundled base scope: virtual-fs hydration, WASM brotli decompression, and flowR's reader all have to work together
	test('the bundled base-R signature scope is really readable in the web build', async function() {
		this.timeout(30000);
		assert.ok(getSigDbScopeState('base').manifest, 'expected the bundled base scope to expose a manifest');

		const found = await findSigDbPackageSource('compiler');
		assert.ok(found, 'expected the base-R package "compiler" to resolve from the bundled scope');
		assert.ok(safeSigDbCall(() => found.source.latestVersion('compiler'))?.str, 'expected a real version for "compiler"');
		const fns = safeSigDbCall(() => found.source.functions('compiler', undefined)) ?? [];
		assert.ok(fns.some(f => f.name === 'cmpfun'), `expected compiler::cmpfun among the decoded functions, got: ${fns.slice(0, 5).map(f => f.name).join(', ')}`);
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
