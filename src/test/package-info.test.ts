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

	const hoverContentsAt = async(pos: vscode.Position) => {
		const editor = await openTestFile('package-info-example.R');
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		return (result ?? []).flatMap(h => h.contents).map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
	};

	test('shows the database version when hovering a library() package name', async() => {
		// `purrr` inside `library(purrr)` on the first line
		const contents = await hoverContentsAt(new vscode.Position(0, 9));
		const versionHover = contents.find(v => v.includes('purrr') && /database version/i.test(v));
		assert.ok(versionHover, `expected a database-version hover for the library name, got: ${JSON.stringify(contents)}`);
	});

	test('shows the loaded package version when hovering the library function itself', async() => {
		// hovering `library` in `library(purrr)` should report the package it loads and its database version
		const contents = await hoverContentsAt(new vscode.Position(0, 2));
		const loadHover = contents.find(v => /loads the/i.test(v) && v.includes('purrr') && /database version/i.test(v));
		assert.ok(loadHover, `expected a 'loads the purrr package' hover, got: ${JSON.stringify(contents)}`);
	});

	test('attributes a base built-in (print) to its base package', async() => {
		const editor = await openTestFile('hover-bottom-example.R');
		// `print` on the second line is a base built-in, available without library()
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(1, 0));
		const contents = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '');
		const baseHover = contents.find(v => /provided by/.test(v) && v.includes('base'));
		assert.ok(baseHover, `expected 'print is provided by the base package', got: ${JSON.stringify(contents)}`);
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
