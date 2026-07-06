import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';

suite('package info', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	test('hover attributes a package function to its package', async() => {
		const editor = await openTestFile('package-info-example.R');
		// `map` on the second line (`result <- map(...)`) stems from purrr, which is loaded on the first line
		const pos = new vscode.Position(1, 11);
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		assert.ok(result, 'failed to get hover result');

		const contents = result
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const packageHover = contents.find(v => v.includes('purrr'));
		assert.ok(packageHover, `expected a hover attributing 'map' to the purrr package, got: ${JSON.stringify(contents)}`);
		assert.ok(/provided by/.test(packageHover), `expected the package hover to explain the origin, got: ${packageHover}`);
	});

	test('does not attribute a locally defined function to a package', async() => {
		const editor = await openTestFile('package-info-example.R');
		// `myFunction` is defined in this very file, so we must not claim it comes from a package
		const pos = new vscode.Position(5, 3);
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		assert.ok(!contents.some(v => /provided by/.test(v)), `did not expect a package hover for a local function, got: ${JSON.stringify(contents)}`);
	});

	test('jumps to the definition of a locally defined function', async() => {
		const editor = await openTestFile('package-info-example.R');
		// the call `myFunction(2)` on the last line should resolve to its definition on line 3 (index 2)
		const pos = new vscode.Position(5, 3);
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos);
		assert.ok(result && result.length > 0, 'expected at least one definition location');
		assert.ok(
			result.some(loc => loc.range.start.line === 2),
			`expected a definition on line 3 (index 2), got lines: ${result.map(l => l.range.start.line).join(', ')}`
		);
	});
});
