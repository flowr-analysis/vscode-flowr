import assert from 'assert';
import type * as vscode from 'vscode';
import { loadedPackagesIn, callBeforeCursor, packageArgumentCompletions, resolveArgNameAgainst, resolveCallArgs } from '../completion';

function labelOf(item: vscode.CompletionItem): string {
	return typeof item.label === 'string' ? item.label : item.label.label;
}

suite('completion', () => {
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
