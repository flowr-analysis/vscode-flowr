import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import type { FlowrInternalSession } from '../flowr/internal-session';

suite('analyzer concurrency', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	// A single keystroke fans out to several features at once (dependency view, hover values, linter), all
	// analysing the SAME document. flowR's pipeline is not re-entrant, so before serialization these raced and
	// threw `Cannot read properties of undefined (reading 'ast')`, which the dependency view swallowed and then
	// (with keepOnError) showed stale data - i.e. "typing does not update the view". This reproduces that fan-out.
	test('many concurrent analyses of one document all succeed', async() => {
		const editor = await openTestFile('vapply-example.R');
		const session: FlowrInternalSession = await vscode.commands.executeCommand('vscode-flowr.session.internal');
		assert.ok(session, 'internal session must be available');

		const runs = Array.from({ length: 16 }, () =>
			session.retrieveQuery(editor.document, [{ type: 'dependencies' }])
		);
		const results = await Promise.allSettled(runs);

		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		assert.equal(rejected.length, 0, `no concurrent analysis should throw, but got: ${rejected.map(r => (r.reason as Error)?.message).join('; ')}`);

		for(const r of results) {
			const value = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof session.retrieveQuery>>>).value;
			assert.equal(value.hasError, false, 'every concurrent analysis should complete without error');
			// every run must agree on the six detected libraries (a corrupted pipeline would yield fewer/none)
			const libs = (value.result.dependencies?.library ?? []).length;
			assert.equal(libs, 6, `expected all 6 libraries every time, got ${libs}`);
		}
	});
});
