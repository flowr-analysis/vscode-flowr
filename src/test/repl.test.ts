import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension } from './test-util';
import type { FlowrInternalSession } from '../flowr/internal-session';

suite('repl', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	// we validate the REPL startup (analyzer build + banner) rather than the interactive loop, which reads from
	// the terminal and would end the process on EOF
	test('builds its analyzer and banner including the signature database status', async() => {
		const session: FlowrInternalSession = await vscode.commands.executeCommand('vscode-flowr.session.internal');
		assert.ok(session, 'internal session must be available');

		const startup = await session.replStartup();
		assert.ok(startup, 'the REPL must build an analyzer and banner');
		assert.ok(startup.analyzer, 'the REPL analyzer must be constructed');
		assert.ok(/flowR/i.test(startup.banner), `expected the flowR version banner, got: ${startup.banner}`);
		// real status derived from on-disk manifest state (see `sigDbSummary`) - a clean test profile has
		// nothing downloaded, so this only checks the line is present, not which state it reports
		assert.ok(/signature db/i.test(startup.banner), `expected a signature database status line, got: ${startup.banner}`);
	});
});
