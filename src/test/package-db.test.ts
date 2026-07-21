import assert from 'assert';
import { closestPackageNames } from '../package-db';

suite('package-db', () => {
	suite('closestPackageNames', () => {
		test('suggests the real package name for a plausible typo', () => {
			assert.deepStrictEqual(closestPackageNames('ggplot', ['ggplot2', 'dplyr', 'purrr']), ['ggplot2']);
		});

		test('is case-insensitive', () => {
			assert.deepStrictEqual(closestPackageNames('GGPlot2', ['ggplot2', 'dplyr']), ['ggplot2']);
		});

		test('returns nothing when no known name is close enough to be a plausible typo', () => {
			assert.deepStrictEqual(closestPackageNames('ggplot2', ['dplyr', 'purrr', 'tidyr']), []);
		});

		test('never suggests the typed name itself, even if it is technically "known"', () => {
			assert.deepStrictEqual(closestPackageNames('dplyr', ['dplyr', 'plyr']), ['plyr']);
		});

		test('caps the number of suggestions at `max`, closest first', () => {
			const known = ['dplyr', 'dplyr2', 'dplyrx', 'dplyrz'];
			const result = closestPackageNames('dplyr1', known, 2);
			assert.strictEqual(result.length, 2);
		});
	});
});
