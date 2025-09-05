// also see https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/client/src/test/helper.ts for various test helper samples

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import type { FlowrInternalSession } from '../flowr/internal-session';

export async function activateExtension(): Promise<void> {
	const ext = vscode.extensions.getExtension('code-inspect.vscode-flowr');

	assert.notEqual(ext, undefined, 'extension not found');

	await assert.doesNotReject(async() => {
		await ext?.activate();
	}, 'extension activation failed');

	// force start a local shell and wait, since there seem to be some async issues with commands
	const session: FlowrInternalSession = await vscode.commands.executeCommand('vscode-flowr.session.internal');
	assert.equal(session.state, 'active');
}

export async function openTestFile(name: string, selection?: vscode.Selection): Promise<vscode.TextEditor> {
	const file = path.resolve(__dirname, '..', '..', 'test-workspace', name);
	const doc = await vscode.workspace.openTextDocument(file);
	const editor = await vscode.window.showTextDocument(doc);
	if(selection) {
		editor.selection = selection;
	}
	return editor;
}
