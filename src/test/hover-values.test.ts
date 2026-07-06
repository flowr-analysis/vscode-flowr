import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';


suite('hover values', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	const tc = async(pos: vscode.Position, expected: string) => {
		const editor = await openTestFile('hover-values-example.R');
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		assert.ok(result, 'failed to get result');
		assert.equal(result.length, 1, `expected 1 result but got ${result.length}`);

		const hover = result[0].contents[0] as vscode.MarkdownString;
		assert.equal(hover.value, `**Inferred Value**\n\n${expected}`);
	};

	test('shows inferred value for variable', async() => {
		await tc(new vscode.Position(0, 1), '[2L, 2L]');
		await tc(new vscode.Position(0, 5), '[2L, 2L]');
	});

	test('shows inferred value correctly in sequences', async() => {
		await tc(new vscode.Position(1, 5), '[3L, 3L]');
		await tc(new vscode.Position(1, 7), '[40L, 40L]');
	});

	test('does not show a hover when the value is bottom (e.g. print)', async() => {
		const editor = await openTestFile('hover-bottom-example.R');
		// `print(x)` on line 2 resolves to bottom - we must not surface an "Inferred Value ⊥" hover for it
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(1, 0));
		const values = (result ?? [])
			.flatMap(h => h.contents)
			.map(c => (c as vscode.MarkdownString).value ?? '');
		assert.ok(!values.some(v => v.includes('Inferred Value') && v.includes('⊥')), `did not expect a bottom inferred-value hover, got: ${JSON.stringify(values)}`);
	});

	test('shows inferred value for dataframe', async() => {
		const df = `
Dataframe Shape:

*Columns*: \`id\`, \`label\`\\
*Cols*: [2, 2]\\
*Rows*: [3, 3]
		`.trim();
		await tc(new vscode.Position(2, 1), df);
	});
});

