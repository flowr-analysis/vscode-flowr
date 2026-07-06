import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';
import type { SourceLocation } from '@eagleoutice/flowr/util/range';
import { isInRPackage, isLocInDocument } from '../lint';

suite('linter', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	// findings located in `source()`d scripts must not be shown in the sourcing document
	suite('isLocInDocument', () => {
		const doc = { fileName: '/home/user/main.R', uri: vscode.Uri.file('/home/user/main.R') };

		test('keeps findings with no file attribution (the in-buffer document)', () => {
			assert.ok(isLocInDocument([1, 1, 1, 5] as SourceLocation, doc));
			assert.ok(isLocInDocument([1, 1, 1, 5, '@inline'] as SourceLocation, doc));
		});

		test('keeps findings that belong to the document itself', () => {
			assert.ok(isLocInDocument([1, 1, 1, 5, '/home/user/main.R'] as SourceLocation, doc));
			assert.ok(isLocInDocument([1, 1, 1, 5, 'file:///home/user/main.R'] as SourceLocation, doc));
		});

		test('drops findings that belong to a sourced/other file', () => {
			assert.ok(!isLocInDocument([1, 1, 1, 5, '/home/user/sourced.R'] as SourceLocation, doc));
		});
	});

	// package-only rules (license/tests) are only sensible inside an R package
	suite('isInRPackage', () => {
		test
		('is true for a file inside an R package (DESCRIPTION up the tree)', async() => {
			const editor = await openTestFile('pkg-example/R/example.R');
			assert.ok(await isInRPackage(editor.document));
		});

		test('is false for a standalone example script', async() => {
			const editor = await openTestFile('example.R');
			assert.ok(!(await isInRPackage(editor.document)));
		});
	});

	test('quick fix', async() => {
		const editor = await openTestFile('lint-example.R');
		const result: vscode.CodeAction[] = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
			editor.document.uri, new vscode.Range(0, 0, 3, 0), vscode.CodeActionKind.QuickFix.value, 1);
		assert.ok(result);
		assert.equal(result.length, 1);

		const action = result[0];
		assert.ok(action);
		assert.equal(action.title, 'Remove unused definition of `x`');
		assert.ok(action.edit);
		assert.ok(await vscode.workspace.applyEdit(action.edit));

		assert.equal(editor.document.getText().replaceAll('\r\n', '\n'), `
cat("1")
; cat("2")
cat("3")
`.trimStart());
	});
});
