import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import type { SliceReturn } from '../flowr/utils';
import type { PositionSlicer } from '../position-slicer';

suite('slice', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	test('backward slice cursor', async() => {
		await openTestFile('example.R', new vscode.Selection(7, 6, 7, 6));
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
		assert.ok(slice);
		assert.equal(slice.code, `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim());
	});

	// a syntax error in an unrelated part of the file (e.g. another R Markdown chunk) must not disable slicing everywhere
	test('slices despite a syntax error elsewhere in the file', async() => {
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'x <- 1\ny <- x + 1\n\nbroken <- (\n' });
		const editor = await vscode.window.showTextDocument(doc);
		editor.selection = new vscode.Selection(1, 0, 1, 0);
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
		assert.ok(slice?.code.includes('x <- 1'), `expected the slice of y, got: ${slice?.code}`);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});

	test('forward slice cursor', async() => {
		await openTestFile('example.R', new vscode.Selection(0, 0, 0, 0));
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.forward-slice.cursor');
		assert.ok(slice);
		assert.deepEqual(slice.sliceElements.map(e => e.location), [
			[1, 1, 1, 3], [1, 5, 1, 6], // line 1: sum <-
			[6, 1, 6, 3], // line 6: for
			[7, 3, 7, 5], [7, 7, 7, 8], [7, 10, 7, 12], [7, 14, 7, 14], [7, 18, 7, 18], // line 7: sum <- sum + +
			[11, 1, 11, 3], [11, 13, 11, 15] // line 12: cat, sum
		]);
	});

	test('reconstruct cursor', async() => {
		await openTestFile('example.R', new vscode.Selection(7, 6, 7, 6));
		const newEditor: vscode.TextEditor | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.show.in.editor');
		assert.ok(newEditor);
		assert.ok(newEditor.document.fileName.endsWith('Selection Slice'));
		assert.equal(newEditor.document.getText(), `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim());
	});

	// slicing with the cursor on a function-name (e.g. `print`, `ggplot`) must resolve to the enclosing call
	// node (the name symbol is not a dataflow vertex), otherwise the slice comes back empty - especially once
	// package functions are resolved via the package database
	test('slices on a function call (print) and includes its dependency', async() => {
		await openTestFile('slice-library-example.R', new vscode.Selection(3, 0, 3, 0)); // cursor on `print`
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
		assert.ok(slice, 'expected a slice result');
		assert.notEqual(slice.code.trim(), '', 'slice on a function call must not be empty');
		assert.ok(slice.code.includes('print(x)'), `expected the call in the slice, got: ${slice.code}`);
		assert.ok(slice.code.includes('x <- 5'), `expected the sliced dependency, got: ${slice.code}`);
	});

	test('slices on a library-provided call (ggplot) and includes the library', async() => {
		await openTestFile('slice-library-example.R', new vscode.Selection(2, 0, 2, 0)); // cursor on `ggplot`
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
		assert.ok(slice, 'expected a slice result');
		assert.ok(slice.code.includes('ggplot()'), `expected the ggplot call in the slice, got: ${slice.code}`);
		assert.ok(slice.code.includes('library(ggplot2)'), `expected the library load in the slice, got: ${slice.code}`);
	});

	suite('position slices', () => {
		const sumPos = new vscode.Selection(6, 2, 6, 2); // `sum` in the loop
		const productPos = new vscode.Selection(7, 2, 7, 2); // `product` in the loop
		const cfg = () => vscode.workspace.getConfiguration('vscode-flowr');

		async function reconstruction(): Promise<string> {
			const editor: vscode.TextEditor = await vscode.commands.executeCommand('vscode-flowr.slice.show.in.editor');
			return editor.document.getText();
		}

		async function sliceBoth(): Promise<string> {
			const editor = await openTestFile('example.R');
			editor.selections = [sumPos, productPos];
			await vscode.commands.executeCommand('vscode-flowr.slice.position');
			return await reconstruction();
		}

		async function closeReconstruction(): Promise<void> {
			const isRecon = (e: vscode.TextEditor) => e.document.uri.scheme === 'flowr';
			const editor = vscode.window.visibleTextEditors.find(isRecon);
			assert.ok(editor, 'reconstruction should be open');
			await vscode.window.showTextDocument(editor.document, editor.viewColumn);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await new Promise(r => setTimeout(r, 300));
			assert.ok(!vscode.window.visibleTextEditors.some(isRecon), 'reconstruction should be closed');
		}

		teardown(async() => {
			await vscode.commands.executeCommand('vscode-flowr.slice.clear');
			await cfg().update('slice.positionCombination', undefined, vscode.ConfigurationTarget.Global);
			await cfg().update('slice.negative', undefined, vscode.ConfigurationTarget.Global);
			await cfg().update('style.sliceDisplay', undefined, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		});

		test('union and intersection of two positions', async() => {
			const union = await sliceBoth();
			assert.ok(union.includes('sum <- sum + i + w') && union.includes('product <- product * i'), union);
			await vscode.commands.executeCommand('vscode-flowr.slice.clear');

			await vscode.commands.executeCommand('vscode-flowr.slice.position.toggleCombination');
			assert.equal(cfg().get('slice.positionCombination'), 'intersection');
			const intersection = await sliceBoth();
			assert.equal(intersection, 'n <- 10\nfor(i in 1:(n - 1)) {}');
			assert.ok(union.includes('n <- 10') && union.includes('for(i in 1:(n - 1))'), 'intersection must be a subset of the union');
			assert.ok(!intersection.includes('sum <- sum') && !intersection.includes('product <- product'));
		});

		test('negative slice reconstruction shows lines outside the slice', async() => {
			await vscode.commands.executeCommand('vscode-flowr.slice.toggleNegative');
			assert.equal(cfg().get('slice.negative'), true);
			const editor = await openTestFile('example.R', sumPos);
			await vscode.commands.executeCommand('vscode-flowr.slice.position');
			const text = await reconstruction();
			assert.equal(text, 'product <- 1\n\n  product <- product * i\n}\n\ncat("Sum:", sum, "\\n")\ncat("Product:", product, "\\n")\n');
			assert.ok(editor.document.getText().includes('sum <- 0'));
		});

		test('a closed reconstruction is not reopened until cleared', async() => {
			const editor = await openTestFile('example.R', sumPos);
			await vscode.commands.executeCommand('vscode-flowr.slice.position');
			await reconstruction();
			await closeReconstruction();

			await vscode.window.showTextDocument(editor.document);
			editor.selection = productPos;
			await vscode.commands.executeCommand('vscode-flowr.slice.position');
			await new Promise(r => setTimeout(r, 500));
			assert.ok(!vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'flowr'), 'must not auto reopen');

			await reconstruction();
			assert.ok(vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'flowr'), 'explicit command must open');
		});

		test('fold hides code outside the slice and clear unfolds it', async() => {
			const editor = await openTestFile('example.R', new vscode.Selection(6, 2, 6, 2));
			await vscode.commands.executeCommand('vscode-flowr.slice.position');
			await vscode.commands.executeCommand('vscode-flowr.slice.fold');
			const visible = () => editor.visibleRanges.flatMap(r => [r.start.line, r.end.line]);
			assert.ok(!editor.visibleRanges.some(r => r.start.line <= 10 && r.end.line >= 11), `lines 10-11 should be folded: ${JSON.stringify(visible())}`);
			await vscode.commands.executeCommand('vscode-flowr.slice.clear');
			assert.ok(editor.visibleRanges.some(r => r.start.line <= 1 && r.end.line >= 11), `should be unfolded: ${JSON.stringify(visible())}`);
		});

		test('diff display never auto-opens the reconstruction', async() => {
			await cfg().update('style.sliceDisplay', 'diff', vscode.ConfigurationTarget.Global);
			await openTestFile('example.R', sumPos);
			await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
			await new Promise(r => setTimeout(r, 500));
			assert.ok(!vscode.window.visibleTextEditors.some(e => e.document.uri.authority === 'selection-slicer'));
		});
	});
});

suite('position slice', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	async function waitFor(condition: () => boolean, timeoutMs = 20000): Promise<void> {
		const start = Date.now();
		while(!condition()) {
			assert.ok(Date.now() - start < timeoutMs, 'timed out waiting for the position slice to update');
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}

	// typing in quick succession must leave the forward slice of the latest text, never that of an earlier keystroke
	test('forward position slice follows uses typed afterwards', async() => {
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'x <- 1\nprint(x)\n' });
		const editor = await vscode.window.showTextDocument(doc);
		editor.selection = new vscode.Selection(0, 0, 0, 0);
		const slicer: PositionSlicer | undefined = await vscode.commands.executeCommand('vscode-flowr.forward-slice.position');
		assert.ok(slicer);
		const lines = () => new Set(slicer.lastSlice?.sliceElements.map(e => e.location[0]));
		await waitFor(() => lines().has(2));

		for(const ch of 'y <- x + 1\n') {
			await editor.edit(eb => eb.insert(new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length), ch));
		}
		await waitFor(() => lines().has(3));
		assert.deepStrictEqual([...lines()].sort(), [1, 2, 3]);
		await vscode.commands.executeCommand('vscode-flowr.slice.clear');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});
});
