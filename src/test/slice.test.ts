import * as vscode from 'vscode';
import * as assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import type { SliceReturn } from '../flowr/utils';

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
});
