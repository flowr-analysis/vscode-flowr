import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';


suite('hover values', () => {
	let editor: vscode.TextEditor;

	const tc = async(pos: vscode.Position, expected: string) => {
		const result: vscode.Hover[] = await vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, pos);
		assert.ok(result);
		assert.equal(result.length, 1);

		const hover = result[0].contents[0] as vscode.MarkdownString;
		assert.equal(hover.value, `**Inferred Value**\n\n${expected}`);
	};

	suiteSetup(async() => {
		await activateExtension();
		editor = await openTestFile('hover-values-example.R');
	});

	test.only('shows inferred value for variable', async() => {
		await tc(new vscode.Position(0, 1), '[2L, 2L]');
		await tc(new vscode.Position(0, 5), '[2L, 2L]');
	});

	test.only('shows inferred value correctly in sequences', async() => {
		await tc(new vscode.Position(1, 5), '[3L, 3L]');
		await tc(new vscode.Position(1, 7), '[40L, 40L]');
	});

	test.only('shows inferred value for dataframe', async() => {
		const df = `Dataframe Shape:
|    |    |
|----|----|
| Rows: | [3, 3] |
| Cols: | [2, 2] |

Known Columns: \`id\`, \`label\``;
		await tc(new vscode.Position(2, 1), df);
	});
});

