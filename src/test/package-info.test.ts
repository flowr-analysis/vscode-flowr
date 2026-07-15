import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';
import { remoteLinkRedirectUri } from '../package-info';

suite('package info', () => {
	suiteSetup(async() => {
		await activateExtension();
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

	// regression test: clicking a variable/function at its own definition (not a use of it) has no dataflow
	// "origin" to resolve - it is not a read of anything - so it must not come up empty ("no references found")
	test('clicking a local function definition itself resolves to its own location, not nothing', async() => {
		const editor = await openTestFile('package-info-example.R');
		// `myFunction` on line 3 (index 2) is the definition itself, not a use of it
		const pos = new vscode.Position(2, 3);
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, pos);
		assert.ok(result && result.length > 0, 'expected the definition to resolve to itself rather than nothing');
		assert.ok(
			result.some(loc => loc.range.start.line === 2),
			`expected a location on line 3 (index 2), got lines: ${result.map(l => l.range.start.line).join(', ')}`
		);
	});

	test('clicking a local variable definition (not a function) itself resolves to its own location', async() => {
		const editor = await openTestFile('definition-self-example.R');
		// `df` on line 5 (index 4) is the definition itself: `df <- data.frame(x = 1:5)`
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', editor.document.uri, new vscode.Position(4, 0));
		assert.ok(result && result.length > 0, 'expected the definition to resolve to itself rather than nothing');
		assert.ok(
			result.some(loc => loc.range.start.line === 4),
			`expected a location on line 5 (index 4), got lines: ${result.map(l => l.range.start.line).join(', ')}`
		);
	});

	// regression test: "Find All References" on a local definition used to always say "No references found" -
	// no ReferenceProvider was registered at all, so VS Code's own fallback (with nothing to ask) always came
	// up empty, even though flowR's dataflow graph already knows every use via `Reads` edges
	test('finds all references to a local variable, including its own definition', async() => {
		const editor = await openTestFile('definition-self-example.R');
		// `df` is defined on line 5 (index 4) and used on line 6 (index 5)
		const result: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeReferenceProvider', editor.document.uri, new vscode.Position(4, 0));
		assert.ok(result && result.length > 0, 'expected at least one reference');
		const lines = result.map(l => l.range.start.line).sort();
		assert.deepStrictEqual(lines, [4, 5], `expected references on both the definition (line 5) and its use (line 6), got lines: ${lines.join(', ')}`);
	});

	// regression test for the redirect mechanism behind Ctrl+click on a remote-only target (e.g. ggplot's
	// GitHub source, or a library()'s CRAN page): opening it must show explanatory placeholder content and
	// then close its own tab automatically, rather than leaving a permanent fake document open in the editor
	test('opening a remote-link redirect URI shows placeholder content and closes its own tab', async() => {
		const target = 'https://example.com/vscode-flowr-test-link';
		const uri = remoteLinkRedirectUri(target);

		const doc = await vscode.workspace.openTextDocument(uri);
		assert.ok(doc.getText().includes(target), `expected the placeholder content to mention the target, got: ${doc.getText()}`);

		await vscode.window.showTextDocument(doc);
		await new Promise(resolve => setTimeout(resolve, 500));

		const stillOpen = vscode.window.tabGroups.all
			.flatMap(g => g.tabs)
			.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
		assert.ok(!stillOpen, 'expected the placeholder tab to have closed itself');
	});
});
