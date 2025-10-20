import type { SliceReturn } from '../flowr/utils';
import { activateExtension, openTestFile } from './test-util';
import * as vscode from 'vscode';
import * as assert from 'assert';

suite('rmd support', () => {

	suiteSetup(async() => {
		await activateExtension();
	});

	test('backward slice cursor (rmd)', async() => {
		const editor = await openTestFile('example.Rmd', new vscode.Selection(14, 4, 14, 4));
		assert.ok('rmd' === editor.document.languageId, editor.document.languageId);
		const slice: SliceReturn | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor');
		assert.ok(slice);
		assert.equal(slice.code, 'x <- 42\nx <- x + 1\nx');
	});
});