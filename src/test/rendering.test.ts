import assert from 'assert';
import type { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { renderFunctionName } from '../flowr/views/dependency-view';
import { rangeToVscodeRange } from '../flowr/utils';

suite('rendering helpers', () => {
	suite('renderFunctionName', () => {
		test('renders a namespaced identifier tuple as valid R', () => {
			// flowR represents `purrr::map` as the tuple ['map', 'purrr', false]; stringified naively this
			// would read `map,purrr,false`, so it must come out as `purrr::map`
			assert.equal(renderFunctionName(['map', 'purrr', false] as unknown as Identifier), 'purrr::map');
			assert.equal(renderFunctionName(['read_csv', 'readr', false] as unknown as Identifier), 'readr::read_csv');
		});

		test('passes a plain identifier through unchanged', () => {
			assert.equal(renderFunctionName('library' as unknown as Identifier), 'library');
		});
	});

	suite('rangeToVscodeRange', () => {
		test('converts 1-based flowR ranges to 0-based VS Code ranges', () => {
			const range = rangeToVscodeRange([2, 3, 2, 8] as SourceRange);
			assert.equal(range.start.line, 1);
			assert.equal(range.start.character, 2);
			assert.equal(range.end.line, 1);
			assert.equal(range.end.character, 8);
		});

		test('clamps to zero instead of throwing on a synthetic line 0 (robustness)', () => {
			// a finding without a proper location must not take down a whole diagnostics pass
			assert.doesNotThrow(() => rangeToVscodeRange([0, 0, 0, 0] as SourceRange));
			const range = rangeToVscodeRange([0, 0, 0, 0] as SourceRange);
			assert.ok(range.start.line >= 0 && range.start.character >= 0);
		});
	});
});
