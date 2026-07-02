import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { getNodeIdAt, makeSlicingCriteriaForPositions, selectionsToNodeIds, type FlowrSession } from '../flowr/utils';
import assert from 'assert';
import * as vscode from 'vscode';
import type { FlowrExtensionApi } from '../extension';
import { activateExtension } from './test-util';

suite('util', () => {
	// for the tree-sitter path to be correct, we use the flowR extension's config
	let api: FlowrExtensionApi;
	suiteSetup(async() => {
		api = await activateExtension();
	});

	suite('selection to node ids', () => {
		const cases = [
			{ selections: [], expected: undefined },
			{ selections: [new vscode.Selection(0, 0, 0, 2)], expected: [0] },
			{ selections: [new vscode.Selection(0, 0, 0, 3)], expected: [2, 0] },
			{ selections: [new vscode.Selection(0, 0, 0, 3), new vscode.Selection(1, 0, 1, 3)], expected: [2, 0, 5, 3] },
		];
		cases.forEach(({ selections, expected }) => {
			test(`should only include selected nodeids ${expected?.join(', ') ?? '(none)'}`, async() => {
				const analyzer = await new FlowrAnalyzerBuilder(false)
					.setConfig(api.flowrConfig())
					.setEngine('tree-sitter')
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

	suite('slicing criteria from positions', () => {
		let session: FlowrSession;
		suiteSetup(async() => {
			session = await vscode.commands.executeCommand<FlowrSession>('vscode-flowr.session.internal');
		});

		const open = (content: string) => vscode.workspace.openTextDocument({ language: 'r', content });

		test('resolves a node id at a variable position', async() => {
			const doc = await open('x <- 5\ny <- 10\n');
			const id = await getNodeIdAt(new vscode.Position(0, 0), doc, session);
			assert.notEqual(id, undefined, 'expected a node id for the variable position');
		});

		test('snaps whitespace adjacent to an identifier to that identifier', async() => {
			const doc = await open('x <- 5\n');
			const onVar = await getNodeIdAt(new vscode.Position(0, 0), doc, session);
			const onSpace = await getNodeIdAt(new vscode.Position(0, 1), doc, session);
			assert.notEqual(onVar, undefined);
			assert.equal(onSpace, onVar);
		});

		test('does not emit a "$undefined" criterion for unresolvable positions', async() => {
			const doc = await open('x <- 5\n\n\ny <- 10\n');
			const criteria = await makeSlicingCriteriaForPositions([
				new vscode.Position(0, 0),
				new vscode.Position(1, 0),
				new vscode.Position(2, 0),
				new vscode.Position(3, 0)
			], doc, session);
			assert.ok(criteria.every(c => !c.includes('undefined')), `criteria must not contain "$undefined": ${JSON.stringify(criteria)}`);
			assert.ok(criteria.every(c => c.startsWith('$')));
			assert.ok(criteria.length >= 2);
		});
	});
});
