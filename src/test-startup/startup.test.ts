import * as vscode from 'vscode';
import assert from 'assert';

/* runs in its own VS Code instance that starts with an R file open (see .vscode-test.mjs), so the extension activates
 * because of that file and its features start analyzing it while activation is still running */
suite('startup with an R file open', () => {
	test('analyzes the file that triggered the activation', async() => {
		const ext = vscode.extensions.getExtension('code-inspect.vscode-flowr');
		assert.ok(ext, 'extension not found');
		await ext.activate();
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor?.document.fileName.endsWith('line-categories-example.R'), `unexpected editor ${editor?.document.fileName}`);
		const lines = await vscode.commands.executeCommand<{ line: number, categories: string[] }[]>('vscode-flowr.internal.lineCategories');
		assert.deepStrictEqual(lines.map(l => l.line), [0, 1, 3, 4], JSON.stringify(lines));
	});
});
