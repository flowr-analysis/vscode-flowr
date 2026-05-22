import * as vscode from 'vscode';
import { activateExtension, openTestFile } from './test-util';
import assert from 'assert';
import type { WebviewCallbacks } from '../flowr/diagrams/diagram';


async function testDiagramGeneration(command: string) {
	await openTestFile('simple-example.R');
	const result = await new Promise<{ error: boolean }>((resolve) => {
		vscode.commands.executeCommand(command, {
			onError(_message) {
				resolve({ error: true });
			},
			onGenerated() {
				resolve({ error: false });
			}
		} as WebviewCallbacks);
	});

	assert.equal(result.error, false);
}

suite('diagram', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	test('dataflow', async() => {
		await testDiagramGeneration('vscode-flowr.dataflow');
	});

	test('ast', async() => {
		await testDiagramGeneration('vscode-flowr.ast');
	});

	test('cfg', async() => {
		await testDiagramGeneration('vscode-flowr.cfg');
	});

	test('call graph', async() => {
		await testDiagramGeneration('vscode-flowr.call-graph');
	});
});

