import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import type { RemovalSlice } from '../removal-slice';

suite('removal slice', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	const removal = async(line: number, character: number) => await vscode.commands.executeCommand<RemovalSlice>('vscode-flowr.internal.removalSlice', new vscode.Position(line, character));

	test('removes the criterion with the code only it needs', async() => {
		await openTestFile('removal-example.R');
		const result = await removal(3, 1);
		assert.deepStrictEqual(result.removedLines, [2, 3], 'helper exists only for the plot, raw is still summarized');
		assert.strictEqual(result.code, 'library(ggplot2)\nraw <- read.csv("data.csv")\nsummary(raw)\n');
	});

	test('shows the whole script without the removed code next to it', async() => {
		const editor = await openTestFile('removal-example.R');
		editor.selection = new vscode.Selection(3, 1, 3, 1);
		await vscode.commands.executeCommand('vscode-flowr.slice.removal');
		const shown = vscode.window.visibleTextEditors.find(e => e.document.uri.authority === 'removal-slice');
		assert.ok(shown, 'the script without the removed code is shown in its own editor, not a diff');
		assert.strictEqual(shown.document.getText(), 'library(ggplot2)\nraw <- read.csv("data.csv")\nsummary(raw)\n');
	});

	test('keeps code that the rest of the script needs', async() => {
		await openTestFile('removal-example.R');
		const result = await removal(4, 1);
		assert.deepStrictEqual(result.removedLines, [4], 'raw is still needed by helper and the plot');
	});

	test('explains why nothing can be removed', async() => {
		await openTestFile('removal-example.R');
		const result = await removal(5, 0);
		assert.ok(result.problem, JSON.stringify(result));
	});

	test('is offered in the editor and the dependency view', () => {
		const menus = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { menus: Record<string, { command: string }[]> } }).contributes.menus;
		assert.ok(menus['editor/context'].some(m => m.command === 'vscode-flowr.slice.removal'));
		assert.ok(menus['view/item/context'].some(m => m.command === 'vscode-flowr.internal.removal-slice.dependency'));
	});
});
