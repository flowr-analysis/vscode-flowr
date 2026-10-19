import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import { symbolScope } from '../symbols';

type Flat = { name: string, kind: string, line: number, parent?: string };

function flatten(symbols: vscode.DocumentSymbol[], parent?: string): Flat[] {
	return symbols.flatMap(s => [{ name: s.name, kind: vscode.SymbolKind[s.kind], line: s.selectionRange.start.line, parent }, ...flatten(s.children, s.name)]);
}

suite('document symbols', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	const symbols = async(uri: vscode.Uri) => flatten(await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri) ?? []);

	test('lists assignments, functions and dependencies', async() => {
		const editor = await openTestFile('search-example.R');
		const found = await symbols(editor.document.uri);
		const has = (name: string, kind: string, line: number) => assert.ok(found.some(f => f.name === name && f.kind === kind && f.line === line), `${name} (${kind}, line ${line}) in ${JSON.stringify(found)}`);
		has('dplyr', 'Package', 0);
		has('data', 'Variable', 1);
		has('measurements.csv', 'File', 1);
		has('clean', 'Variable', 2);
		has('scale', 'Function', 3);
		has('result', 'Variable', 4);
	});

	test('nests the assignments of a function and names plots', async() => {
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'f <- function(x) {\n  y <- x + 1\n  y\n}\nz <- f(1)\nz <- z * 2\n' });
		const found = await symbols(doc.uri);
		assert.deepStrictEqual(found.filter(f => f.kind !== 'Package').map(f => `${f.name}:${f.parent ?? ''}`), ['f:', 'y:f', 'z:'], JSON.stringify(found));
		const plots = await symbols((await openTestFile('plots-example.R')).document.uri);
		assert.ok(plots.some(p => p.kind === 'Event' && p.name === '"Growth over time" → growth.png'), JSON.stringify(plots));
	});

	test('complements the R language server', () => {
		assert.strictEqual(symbolScope('complement', false), 'all');
		assert.strictEqual(symbolScope('complement', true), 'dependencies');
		assert.strictEqual(symbolScope('full', true), 'all');
		assert.strictEqual(symbolScope('off', true), 'none');
		assert.strictEqual(symbolScope('off', false), 'all');
	});

	test('can be disabled', async() => {
		const cfg = vscode.workspace.getConfiguration('vscode-flowr');
		const old = cfg.inspect<boolean>('symbols.enabled')?.workspaceValue;
		try {
			await cfg.update('symbols.enabled', false, vscode.ConfigurationTarget.Workspace);
			// VS Code caches the symbols of a document version, so ask for a fresh document
			const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'library(dplyr)\nx <- 1\n' });
			assert.deepStrictEqual(await symbols(doc.uri), []);
		} finally {
			await cfg.update('symbols.enabled', old, vscode.ConfigurationTarget.Workspace);
		}
	});
});
