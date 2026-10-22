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

	test('removes the setup and teardown of a plot and the comment above it', async() => {
		await openTestFile('removal-outputs.R');
		const result = await removal(5, 1);
		assert.deepStrictEqual(result.removedLines, [2, 3, 4, 5, 6], JSON.stringify(result));
		assert.ok(!/png\(|dev\.off|scaled/.test(result.code) && result.code.includes('summary(raw)'), result.code);
	});

	test('removes the plot drawn into a removed device', async() => {
		await openTestFile('removal-outputs.R');
		for(const [line, character] of [[4, 1], [6, 1]]) {
			const result = await removal(line, character);
			assert.deepStrictEqual(result.removedLines, [2, 3, 4, 5, 6], `${line}: ${JSON.stringify(result)}`);
		}
		await openTestFile('removal-devices.R');
		for(const line of [2, 3, 4]) {
			const cloud = await removal(line, 1);
			assert.deepStrictEqual(cloud.removedLines, [2, 3, 4], 'flowR does not know cloud() as a plot, but it draws into the device');
		}
	});

	test('keeps an output that the script reads again', async() => {
		await openTestFile('removal-devices.R');
		const result = await removal(6, 1);
		assert.ok(result.code.includes('write.csv(summary(m), "copy.csv")'), JSON.stringify(result));
	});

	test('removes an output inside a loop but keeps the loop for the rest', async() => {
		await openTestFile('removal-outputs.R');
		const result = await removal(9, 3);
		assert.deepStrictEqual(result.removedLines, [8, 9], JSON.stringify(result));
		assert.ok(result.code.includes('for(i in 1:2) {\n  print(i)\n}'), result.code);
	});

	test('removes a statement that shares its line with others', async() => {
		await openTestFile('removal-outputs.R');
		const result = await removal(13, 0);
		assert.deepStrictEqual(result.removedLines, [], JSON.stringify(result));
		assert.ok(result.code.includes('\ny <- 2\nprint(y)'), result.code);
	});

	test('removes a printed ggplot with its data and the ggsave of it', async() => {
		await openTestFile('removal-outputs.R');
		const result = await removal(16, 1);
		assert.deepStrictEqual(result.removedLines, [0, 15, 16, 17], 'only this plot needs ggplot2, so its library() goes too');
	});

	test('is offered in the editor and the dependency view', () => {
		const menus = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { menus: Record<string, { command: string }[]> } }).contributes.menus;
		assert.ok(menus['editor/context'].some(m => m.command === 'vscode-flowr.slice.removal'));
		assert.ok(menus['view/item/context'].some(m => m.command === 'vscode-flowr.internal.removal-slice.dependency'));
	});
});
