import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';
import type { SourceLocation } from '@eagleoutice/flowr/util/range';
import { isInRPackage, isLocInDocument, stripFilePath } from '../lint';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';

suite('linter', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	// the diagnostic already points at the file+range, so its message must not repeat the absolute path
	suite('stripFilePath', () => {
		test('removes the finding\'s absolute file path from the message', () => {
			assert.strictEqual(
				stripFilePath('Code at /home/user/main.R:12.3-12.9 can never be executed', [12, 3, 12, 9, '/home/user/main.R'] as SourceLocation),
				'Code at 12.3-12.9 can never be executed'
			);
		});
		test('leaves a message with no file attribution untouched', () => {
			assert.strictEqual(stripFilePath('Code at 12.3-12.9 can never be executed', [12, 3, 12, 9] as SourceLocation), 'Code at 12.3-12.9 can never be executed');
		});
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
		test('is true for a file inside an R package (DESCRIPTION up the tree)', async() => {
			const editor = await openTestFile('pkg-example/R/example.R');
			assert.ok(await isInRPackage(editor.document));
		});

		test('is false for a standalone example script', async() => {
			const editor = await openTestFile('example.R');
			assert.ok(!(await isInRPackage(editor.document)));
		});
	});

	test('enabledRules setting offers every flowR linting rule', () => {
		const pkg = vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { configuration: { properties: Record<string, { items: { enum: string[] } }> } } };
		const setting = pkg.contributes.configuration.properties['vscode-flowr.linter.enabledRules'];
		assert.deepStrictEqual([...setting.items.enum].sort(), Object.keys(LintingRules).sort());
	});

	test('an R Markdown file does not show findings of the scripts it sources', async() => {
		const editor = await openTestFile('sourced-lint/main.Rmd');
		await vscode.commands.executeCommand('vscode-flowr.lint.run');
		const messages = vscode.languages.getDiagnostics(editor.document.uri).filter(d => d.source === 'flowr-lint').map(d => d.message);
		assert.ok(messages.some(m => m.includes('unused_in_main')), `expected the document's own finding, got: ${JSON.stringify(messages)}`);
		assert.ok(!messages.some(m => m.includes('unused_in_helper')), `found a finding of the sourced script: ${JSON.stringify(messages)}`);
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
