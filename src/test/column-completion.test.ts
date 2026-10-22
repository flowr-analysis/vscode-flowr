import assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension } from './test-util';

suite('column completion', () => {
	suiteSetup(async function() {
		this.timeout(60000);
		await activateExtension();
	});

	const columnsAt = async(code: string): Promise<string[]> => {
		const document = await vscode.workspace.openTextDocument({ language: 'r', content: code });
		await vscode.window.showTextDocument(document);
		const end = document.positionAt(code.length);
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, end);
		return list.items.filter(i => i.detail?.includes('column of')).map(i => typeof i.label === 'string' ? i.label : i.label.label).sort();
	};

	test('offers the columns of a data frame after $', async function() {
		this.timeout(60000);
		assert.deepStrictEqual(await columnsAt('df <- data.frame(id = 1:3, score = c(1, 2, 3))\ndf$'), ['id', 'score']);
	});

	test('offers the columns inside [[" and [, "', async function() {
		this.timeout(60000);
		assert.deepStrictEqual(await columnsAt('df <- data.frame(id = 1:3, score = c(1, 2, 3))\ndf[["'), ['id', 'score']);
		assert.deepStrictEqual(await columnsAt('df <- data.frame(id = 1:3, score = c(1, 2, 3))\ndf[, "'), ['id', 'score']);
	});

	test('offers nothing for something that is no data frame', async function() {
		this.timeout(60000);
		assert.deepStrictEqual(await columnsAt('x <- 1:3\nx$'), []);
	});
});
