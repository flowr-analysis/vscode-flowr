// also see https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/client/src/test/helper.ts for various test helper samples

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import type { FlowrInternalSession } from '../flowr/internal-session';
import type { FlowrExtensionApi } from '../extension';
import { downloadSigDbScope, readSigDbRemotePointer } from '../package-db';
import { refreshSigDbConfig } from '../extension';

/**
 * Activate the extension and return its {@link FlowrExtensionApi}
 */
export async function activateExtension(): Promise<FlowrExtensionApi> {
	const ext = vscode.extensions.getExtension('code-inspect.vscode-flowr');

	assert.notEqual(ext, undefined, 'extension not found');

	await assert.doesNotReject(async() => {
		await ext?.activate();
	}, 'extension activation failed');

	const api = (ext as vscode.Extension<FlowrExtensionApi>).exports;
	assert.notEqual(api, undefined, 'extension api not found');

	// force (re-)start local shell and wait, since there seem to be some async issues with commands
	const session: FlowrInternalSession = await vscode.commands.executeCommand('vscode-flowr.session.internal');
	assert.equal(session.state, 'active');

	return api;
}

/**
 *
 */
export async function openTestFile(name: string, selection?: vscode.Selection): Promise<vscode.TextEditor> {
	const file = path.resolve(__dirname, '..', '..', 'test-workspace', name);
	const doc = await vscode.workspace.openTextDocument(file);
	const editor = await vscode.window.showTextDocument(doc);
	if(selection) {
		editor.selection = selection;
	}
	return editor;
}

let sigDbCurrentEnsured: Promise<void> | undefined;

/**
 * Downloads the full `current` and `history` scopes into the default cache dir, for tests that need real
 * signature-database data (package suggestions, source links, per-version evidence) - a fresh checkout/CI
 * runner has none of this synced yet, unlike a machine that has already used the extension for a while.
 * `current` alone only carries each package's *latest* version - even a currently-maintained package's full
 * per-version history (needed for evidence like "parameter X only exists since version Y") lives in `history`.
 * Memoized so repeated calls across suites only download once per test run. A no-op (not a skip) when no
 * release pointer is bundled in this build.
 */
export function ensureSigDbCurrentDownloaded(): Promise<void> {
	sigDbCurrentEnsured ??= (async() => {
		if(!readSigDbRemotePointer()) {
			return;
		}
		await Promise.all([downloadSigDbScope('current'), downloadSigDbScope('history')]);
		// a flowR session may already be alive (e.g. from an earlier activateExtension() call) with its sigdb
		// mount paths baked in from before this download - rebuild it now so it actually sees what just landed
		refreshSigDbConfig();
	})();
	return sigDbCurrentEnsured;
}

