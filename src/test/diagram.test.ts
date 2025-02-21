import * as vscode from 'vscode';
import * as assert from 'assert';

import { activateExtension, openTestFile } from './test-util';

suite('diagram', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	test('dataflow', async() => {
		await openTestFile('simple-example.R');
		const result: {webview: vscode.WebviewPanel, mermaid: string} | undefined =
			await vscode.commands.executeCommand('vscode-flowr.dataflow');
		assert.ok(result);
		assert.equal(result.webview.title, 'Dataflow Graph');
		assert.ok(result.mermaid.startsWith('flowchart'));
	});
});

