import assert from 'assert';
import * as vscode from 'vscode';
import { loadedPackagesIn, callBeforeCursor, packageArgumentCompletions, resolveArgNameAgainst, resolveCallArgs } from '../completion';
import { activateExtension, ensureSigDbCurrentDownloaded } from './test-util';
import { getConfig, Settings } from '../settings';

function labelOf(item: vscode.CompletionItem): string {
	return typeof item.label === 'string' ? item.label : item.label.label;
}

suite('completion', () => {
	// packageArgumentCompletions needs real signature-database package names (ggplot2, dplyr, ...) - a fresh
	// checkout/CI runner has none of this synced yet, unlike a machine that has already used the extension
	suiteSetup(async function() {
		this.timeout(60000);
		await activateExtension();
		await ensureSigDbCurrentDownloaded();
	});

	suite('loadedPackagesIn', () => {
		test('finds packages loaded via library()/require(), quoted or bare', () => {
			assert.deepStrictEqual(loadedPackagesIn('library(dplyr)\nrequire("ggplot2")\nlibrary(\'purrr\')'), new Set(['dplyr', 'ggplot2', 'purrr']));
		});

		test('finds nothing when nothing is loaded', () => {
			assert.deepStrictEqual(loadedPackagesIn('x <- 1'), new Set());
		});
	});

	suite('callBeforeCursor', () => {
		test('detects the enclosing call and an empty first argument slot', () => {
			const call = callBeforeCursor('ggplot(');
			assert.strictEqual(call?.fnName, 'ggplot');
			assert.strictEqual(call.argIndex, 0);
			assert.strictEqual(call.inValuePosition, false);
		});

		test('is undefined outside of any call', () => {
			assert.strictEqual(callBeforeCursor('x <- 1'), undefined);
		});

		test('counts the current argument index by top-level commas', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1, ')?.argIndex, 1);
			assert.strictEqual(callBeforeCursor('add_gg(e1, e2 = aes(x, y), ')?.argIndex, 2);
		});

		// regression test: `add_gg(e1 = |)` must not suggest further argument names - the cursor is in e1's value position
		test('inValuePosition is true right after "name = ", before its value is typed', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1 = ')?.inValuePosition, true);
			assert.strictEqual(callBeforeCursor('add_gg(e1 = 5')?.inValuePosition, true);
		});

		test('inValuePosition is false at the start of a new argument (after a comma, or mid-name)', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1 = 5, ')?.inValuePosition, false);
			assert.strictEqual(callBeforeCursor('add_gg(e')?.inValuePosition, false);
		});
	});

	suite('packageArgumentCompletions', () => {
		test('is undefined outside of a package-name-taking call', async() => {
			assert.strictEqual(await packageArgumentCompletions('ggplot('), undefined);
		});

		test('is undefined for another call\'s argument value (not a package-name argument)', async() => {
			assert.strictEqual(await packageArgumentCompletions('ggplot(data = '), undefined);
		});

		test('suggests packages for library()\'s first (bare) argument', async() => {
			const items = await packageArgumentCompletions('library(dp');
			assert.ok(items);
			assert.ok(items.length > 0, 'expected at least one package suggestion');
		});

		test('suggests packages for library()\'s named `package = ` argument too', async() => {
			const items = await packageArgumentCompletions('library(package = dp');
			assert.ok(items);
			assert.ok(items.length > 0);
		});

		test('does not offer `package:<pkg>` suggestions for library()', async() => {
			const items = await packageArgumentCompletions('library(');
			assert.ok(items);
			assert.ok(!items.some(item => labelOf(item).startsWith('package:')));
		});

		test('offers `package:<pkg>` suggestions alongside bare names for attach()/detach()', async() => {
			for(const fn of ['attach', 'detach']) {
				const items = await packageArgumentCompletions(`${fn}(`);
				assert.ok(items, `expected completions for ${fn}(`);
				assert.ok(items.some(item => labelOf(item).startsWith('package:')), `expected a package: suggestion for ${fn}(`);
				assert.ok(items.some(item => !labelOf(item).startsWith('package:')), `expected a bare-name suggestion for ${fn}(`);
			}
		});

		test('suggests packages for pacman::p_load()\'s unnamed, variadic arguments regardless of position', async() => {
			const items = await packageArgumentCompletions('p_load(dplyr, ');
			assert.ok(items);
			assert.ok(items.length > 0);
		});

		// regression test: `pack = ` must pmatch to `package = ` even without a real sigdb lookup (the single-name fallback still matches)
		test('recognizes a partially-typed named `package = ` argument via R\'s partial-argument matching', async() => {
			const items = await packageArgumentCompletions('library(pack = dp');
			assert.ok(items);
			assert.ok(items.length > 0);
		});

		test('does not treat an unrelated named argument as the package-name argument', async() => {
			assert.strictEqual(await packageArgumentCompletions('library(x = dp'), undefined);
		});
	});

	suite('resolveArgNameAgainst', () => {
		test('matches an exact name', () => {
			assert.strictEqual(resolveArgNameAgainst('data', ['data', 'mapping']), 'data');
		});

		test('matches an unambiguous prefix', () => {
			assert.strictEqual(resolveArgNameAgainst('dat', ['data', 'mapping']), 'data');
		});

		test('is undefined for an ambiguous prefix (matches more than one formal)', () => {
			assert.strictEqual(resolveArgNameAgainst('m', ['mapping', 'multiple']), undefined);
		});

		test('is undefined for a name matching nothing', () => {
			assert.strictEqual(resolveArgNameAgainst('nope', ['data', 'mapping']), undefined);
		});

		test('does not partial-match a formal declared after `...` (R requires an exact name there)', () => {
			assert.strictEqual(resolveArgNameAgainst('en', ['data', '...', 'environment']), undefined);
			assert.strictEqual(resolveArgNameAgainst('environment', ['data', '...', 'environment']), 'environment');
		});
	});

	suite('FlowrSigDbCompletionProvider (real editor)', () => {
		async function completionsIn(content: string, position: vscode.Position): Promise<vscode.CompletionItem[]> {
			const doc = await vscode.workspace.openTextDocument({ language: 'r', content });
			await vscode.window.showTextDocument(doc, { preview: false });
			const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
			return list?.items ?? [];
		}

		// regression test: functions from R's always-loaded packages (stats, utils, ...) used to only complete
		// once the package was named in a library()/require() call in the same file
		test('completes a function from a default-loaded package without any library() call', async() => {
			const items = await completionsIn('ac', new vscode.Position(0, 2));
			assert.ok(items.some(i => labelOf(i) === 'acf'), `expected 'acf' (from stats) to be suggested, got: ${items.map(labelOf).join(', ')}`);
		});

		test('completes a pkg::partial call from a package that is not loaded at all', async() => {
			const items = await completionsIn('dplyr::mut', new vscode.Position(0, 10));
			assert.ok(items.some(i => labelOf(i) === 'mutate'), `expected 'mutate' (from dplyr::) to be suggested, got: ${items.map(labelOf).join(', ')}`);
		});

		test('pkg:::partial also offers non-exported functions', async() => {
			const items = await completionsIn('dplyr:::', new vscode.Position(0, 8));
			assert.ok(items.length > 0, 'expected at least one dplyr internal function to be suggested');
		});

		// regression test: the always-available package set must be user-configurable, not hardcoded
		test('vscode-flowr.completion.alwaysAvailablePackages is configurable', async() => {
			const config = getConfig();
			const previous = config.get<string[]>(Settings.CompletionAlwaysAvailablePackages);
			await config.update(Settings.CompletionAlwaysAvailablePackages, ['base'], vscode.ConfigurationTarget.Global);
			try {
				const items = await completionsIn('ac', new vscode.Position(0, 2));
				assert.ok(!items.some(i => labelOf(i) === 'acf'), 'expected acf (from stats) to no longer be suggested once only base is configured');
			} finally {
				await config.update(Settings.CompletionAlwaysAvailablePackages, previous, vscode.ConfigurationTarget.Global);
			}
		});

		// regression test: dotted names (mostly S3 methods, e.g. print.data.frame) used to clutter completion of
		// their generic's bare prefix - flowR's `s3-method` prop is populated inconsistently across packages
		// (present on base's print.data.frame, absent on stats' print.acf), so name shape plus what the user
		// actually typed is what gates this, not that unreliable metadata
		test('hides dotted names (e.g. print.data.frame, print.acf) until the user types the dot themselves', async() => {
			const items = await completionsIn('print', new vscode.Position(0, 5));
			assert.ok(!items.some(i => labelOf(i) === 'print.data.frame'), `did not expect print.data.frame to be suggested, got: ${items.map(labelOf).join(', ')}`);
			assert.ok(!items.some(i => labelOf(i) === 'print.acf'), `did not expect print.acf to be suggested, got: ${items.map(labelOf).join(', ')}`);
		});

		test('shows dotted names once the user has typed the dot themselves', async() => {
			const items = await completionsIn('print.', new vscode.Position(0, 6));
			assert.ok(items.some(i => labelOf(i) === 'print.data.frame'), `expected print.data.frame to be suggested, got: ${items.map(labelOf).join(', ')}`);
		});

		// regression test: VS Code's default word pattern excludes `.`, so without an explicit range on each
		// item, it tracks "what's been typed" itself and resets to empty right after the dot - showing every
		// completion (abbreviate, abline, ...) unfiltered instead of narrowing to print.* as the user types
		test('sets an explicit range covering the dot, so VS Code filters/replaces against what was actually typed', async() => {
			const items = await completionsIn('print.', new vscode.Position(0, 6));
			const printDataFrame = items.find(i => labelOf(i) === 'print.data.frame');
			assert.ok(printDataFrame, 'expected print.data.frame to be suggested');
			const range = printDataFrame.range as vscode.Range;
			assert.ok(range, `expected an explicit range on the completion item, got: ${JSON.stringify(printDataFrame.range)}`);
			assert.strictEqual(range.start.character, 0, `expected the range to start at the beginning of "print.", got: ${JSON.stringify(range)}`);
			assert.strictEqual(range.end.character, 6, `expected the range to end at the cursor, got: ${JSON.stringify(range)}`);
		});

		test('vscode-flowr.completion.showS3Methods re-enables them even before the dot is typed', async() => {
			const config = getConfig();
			const previous = config.get<boolean>(Settings.CompletionShowS3Methods);
			await config.update(Settings.CompletionShowS3Methods, true, vscode.ConfigurationTarget.Global);
			try {
				const items = await completionsIn('print', new vscode.Position(0, 5));
				assert.ok(items.some(i => labelOf(i) === 'print.data.frame'), `expected print.data.frame to be suggested once S3 methods are enabled, got: ${items.map(labelOf).join(', ')}`);
			} finally {
				await config.update(Settings.CompletionShowS3Methods, previous, vscode.ConfigurationTarget.Global);
			}
		});

		test('does not hide an S3 generic itself (e.g. print), only its dotted methods', async() => {
			const items = await completionsIn('prin', new vscode.Position(0, 4));
			assert.ok(items.some(i => labelOf(i) === 'print'), `expected print (the generic) to still be suggested, got: ${items.map(labelOf).join(', ')}`);
		});
	});

	suite('resolveCallArgs', () => {
		const params = ['data', 'mapping', '...', 'environment'];

		test('resolves a positional argument to the first formal', () => {
			assert.strictEqual(resolveCallArgs(['df'], params).current, 'data');
		});

		test('resolves a partially-typed named argument as the current one', () => {
			assert.strictEqual(resolveCallArgs(['dat = df'], params).current, 'data');
		});

		test('a positional argument still fills an earlier, not-yet-claimed formal even after a later one was named', () => {
			// `mapping` is claimed by name first, but `data` is still free, so the unnamed argument must go to `data`
			const { current } = resolveCallArgs(['mapping = aes(x, y)', 'df'], params);
			assert.strictEqual(current, 'data');
		});

		test('positional matching skips every already-claimed formal and falls through to `...`', () => {
			const { current } = resolveCallArgs(['data = df1', 'mapping = m', 'x'], params);
			assert.strictEqual(current, '...');
		});

		test('a formal after `...` is only reachable by its exact name, never positionally', () => {
			const { current } = resolveCallArgs(['df', 'aes(x, y)', 'e1', 'e2'], params);
			assert.strictEqual(current, '...');
		});

		test('`filled` reflects both named and positionally-assigned formals', () => {
			const { filled } = resolveCallArgs(['df', 'aes(x, y)', ''], params);
			assert.deepStrictEqual(filled, new Set(['data', 'mapping']));
		});
	});
});
