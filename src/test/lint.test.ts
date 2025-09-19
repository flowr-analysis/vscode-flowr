import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';

suite('linter', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	test('quick fix', async() => {
		const editor = await openTestFile('lint-example.R');
		const result: vscode.CodeAction[] = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
			editor.document.uri, new vscode.Range(0,0,3,0), vscode.CodeActionKind.QuickFix.value, 1);
		assert.ok(result);
		assert.equal(result.length, 1);

		const action = result[0];
		assert.ok(action);
		assert.equal(action.title, 'Remove unused definition of `x`');
		assert.ok(action.edit);
		assert.ok(await vscode.workspace.applyEdit(action.edit));
        
		assert.equal(editor.document.getText(), `
cat("1")
; cat("2")
cat("3")
`.trimStart());
	});
});
