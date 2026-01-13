import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { describe, it, suite } from 'mocha';
import { selectionsToNodeIds } from '../flowr/utils';
import { FlowrAnalyzerPluginDefaults } from '@eagleoutice/flowr/project/plugins/flowr-analyzer-plugin-defaults';
import assert from 'assert';
import * as vscode from 'vscode';


suite('util', () => {
	describe('selection to node ids', () => {
		const cases = [
			{ selections: [], expected: undefined },
			{ selections: [new vscode.Selection(0, 0, 0, 2)], expected: [0] },
			{ selections: [new vscode.Selection(0, 0, 0, 3)], expected: [2, 0] },
			{ selections: [new vscode.Selection(0, 0, 0, 3), new vscode.Selection(1, 0, 1, 3),], expected: [2, 0, 5, 3] },

		];


		cases.forEach(({ selections, expected }) => {
			it(`should only include selected nodeids ${expected?.join(', ') ?? '(none)'}`, async() => {
				const analyzer = await new FlowrAnalyzerBuilder()
					.setEngine('tree-sitter')
					.unregisterPlugins(...FlowrAnalyzerPluginDefaults())
					.build();

				analyzer.addFile(new FlowrInlineTextFile('a.R', `x <- 5
y <- 10
z <- 23
					`));
				analyzer.addRequest({ request: 'file', content: 'a.R' });

				const ast = await analyzer.normalize();
				const actual = selectionsToNodeIds(ast.ast.files.map(a => a.root), selections);
				assert.deepEqual(actual?.values().toArray(), expected);
			});
		});
	});
});