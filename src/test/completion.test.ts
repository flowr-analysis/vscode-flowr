import assert from 'assert';
import { loadedPackagesIn, callBeforeCursor } from '../completion';

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
			assert.deepStrictEqual(call.usedArgs, new Set());
			assert.strictEqual(call.inValuePosition, false);
		});

		test('is undefined outside of any call', () => {
			assert.strictEqual(callBeforeCursor('x <- 1'), undefined);
		});

		test('counts the current argument index by top-level commas', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1, ')?.argIndex, 1);
			assert.strictEqual(callBeforeCursor('add_gg(e1, e2 = aes(x, y), ')?.argIndex, 2);
		});

		test('collects already-named arguments, ignoring commas nested inside a value', () => {
			const call = callBeforeCursor('add_gg(e1 = 1, e2 = aes(x, y), ');
			assert.deepStrictEqual(call?.usedArgs, new Set(['e1', 'e2']));
		});

		// regression test: `add_gg(e1 = |)` must not suggest further argument names - the cursor is in the
		// *value* position for e1, not the start of a new argument (that only starts after a comma)
		test('inValuePosition is true right after "name = ", before its value is typed', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1 = ')?.inValuePosition, true);
			assert.strictEqual(callBeforeCursor('add_gg(e1 = 5')?.inValuePosition, true);
		});

		test('inValuePosition is false at the start of a new argument (after a comma, or mid-name)', () => {
			assert.strictEqual(callBeforeCursor('add_gg(e1 = 5, ')?.inValuePosition, false);
			assert.strictEqual(callBeforeCursor('add_gg(e')?.inValuePosition, false);
		});
	});
});
