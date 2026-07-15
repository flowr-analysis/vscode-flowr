import * as vscode from 'vscode';
import { isSigDbEnabled } from './package-db';

/**
 * Watches the `undefined-symbol` lint diagnostics (see `src/lint.ts`) for symbols flowR could resolve if a
 * hinted package's signatures were downloaded, and offers to sync the signature database.
 */

const promptedPackages = new Set<string>();
const promptCooldownMs = 5 * 60 * 1000;
const lastPromptAt = new Map<string, number>();

/** matches the real `undefined-symbol` rule's "Full" pretty-print text (see flowR's `linter/rules/undefined-symbol.js`) */
const ExportedByPattern = /is exported by ((?:`[^`]+`(?:, )?)+)/;

function packagesFromDiagnosticMessage(message: string): string[] {
	const match = ExportedByPattern.exec(message);
	if(!match) {
		return [];
	}
	return [...match[1].matchAll(/`([^`]+)`/g)].map(m => m[1]);
}

async function promptForPackages(packages: string[], output: vscode.OutputChannel): Promise<void> {
	const now = Date.now();
	const fresh = packages.filter(pkg => {
		if(promptedPackages.has(pkg) && (lastPromptAt.get(pkg) ?? 0) + promptCooldownMs > now) {
			return false;
		}
		return true;
	});
	if(fresh.length === 0) {
		return;
	}
	for(const pkg of fresh) {
		promptedPackages.add(pkg);
		lastPromptAt.set(pkg, now);
	}

	// the diagnostic firing already means sigdb resolution failed for this symbol, so whatever is currently
	// downloaded doesn't cover it - no need for an extra lookup here
	const list = fresh.map(p => `\`${p}\``).join(', ');
	const choice = await vscode.window.showInformationMessage(
		`${list} ${fresh.length === 1 ? 'is' : 'are'} not in your current signature database. Sync the signature database to resolve it?`,
		'Sync Signature Database',
		'Dismiss'
	);
	if(choice === 'Sync Signature Database') {
		output.appendLine(`[SigDB] User-initiated sync from undefined-symbol hint for: ${fresh.join(', ')}`);
		await vscode.commands.executeCommand('vscode-flowr.sigdb.download');
	}
}

/** Check undefined-symbol diagnostics and offer to sync the signature database for packages they mention */
export function watchForUndefinedSymbols(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.languages.onDidChangeDiagnostics(e => {
		if(!isSigDbEnabled()) {
			return;
		}
		for(const uri of e.uris) {
			const diags = vscode.languages.getDiagnostics(uri);
			const packages = new Set<string>();
			for(const diag of diags) {
				const code = typeof diag.code === 'object' && diag.code && 'value' in diag.code ? diag.code.value : diag.code;
				if(code !== 'undefined-symbol' || diag.source !== 'flowr-lint') {
					continue;
				}
				for(const pkg of packagesFromDiagnosticMessage(diag.message)) {
					packages.add(pkg);
				}
			}
			if(packages.size > 0) {
				void promptForPackages([...packages], output);
			}
		}
	});
}

/** Register the undefined-symbol to sync-signature-database notification */
export function registerSigDbNotifications(context: vscode.ExtensionContext, output: vscode.OutputChannel): { dispose: () => void } {
	const disposable = watchForUndefinedSymbols(output);
	context.subscriptions.push(disposable);
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		dispose: (): void => disposable.dispose()
	};
}
