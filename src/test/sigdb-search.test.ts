import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSigDbSearchQuery, matchesPattern, matchesVersion, findSigDbMatches } from '../flowr/views/sigdb-view';
import { downloadSigDbScope, readSigDbRemotePointer } from '../package-db';

suite('SigDB search', () => {
	suite('parseSigDbSearchQuery', () => {
		test('parses a plain package', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2'), { pkg: 'ggplot2', version: undefined, fnName: undefined });
		});

		test('parses pkg::fn', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2::ggplot'), { pkg: 'ggplot2', version: undefined, fnName: 'ggplot' });
		});

		test('parses pkg@version', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.5.0'), { pkg: 'ggplot2', version: '3.5.0', fnName: undefined });
		});

		test('parses pkg@version::fn', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.5.0::ggplot'), { pkg: 'ggplot2', version: '3.5.0', fnName: 'ggplot' });
		});

		test('parses glob patterns in every part', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('ggplot2@3.*::ggp*'), { pkg: 'ggplot2', version: '3.*', fnName: 'ggp*' });
		});

		test('trims whitespace around "@" and "::"', () => {
			assert.deepStrictEqual(parseSigDbSearchQuery('  dplyr  @ 1.1.0  ::  mutate  '), { pkg: 'dplyr', version: '1.1.0', fnName: 'mutate' });
		});

		test('rejects an empty or package-less query', () => {
			assert.strictEqual(parseSigDbSearchQuery(''), undefined);
			assert.strictEqual(parseSigDbSearchQuery('::mutate'), undefined);
		});
	});

	suite('matchesPattern', () => {
		test('exact (non-glob) pattern requires an exact match', () => {
			assert.strictEqual(matchesPattern('ggplot2', 'ggplot2'), true);
			assert.strictEqual(matchesPattern('ggplot2', 'ggplot2x'), false);
		});

		test('"*" matches any run of characters', () => {
			assert.strictEqual(matchesPattern('ggp*', 'ggplot'), true);
			assert.strictEqual(matchesPattern('ggp*', 'gg'), false);
			assert.strictEqual(matchesPattern('*plot', 'ggplot'), true);
		});

		test('"?" matches exactly one character', () => {
			assert.strictEqual(matchesPattern('a?c', 'abc'), true);
			assert.strictEqual(matchesPattern('a?c', 'ac'), false);
			assert.strictEqual(matchesPattern('a?c', 'abbc'), false);
		});

		test('glob special characters in the pattern are escaped, not treated as regex', () => {
			assert.strictEqual(matchesPattern('a.b', 'aXb'), false);
			assert.strictEqual(matchesPattern('a.b', 'a.b'), true);
		});
	});

	suite('matchesVersion', () => {
		test('exact version string matches itself', () => {
			assert.strictEqual(matchesVersion('3.5.0', '3.5.0'), true);
			assert.strictEqual(matchesVersion('3.5.0', '3.5.1'), false);
		});

		test('glob version pattern', () => {
			assert.strictEqual(matchesVersion('3.*', '3.5.0'), true);
			assert.strictEqual(matchesVersion('3.*', '4.0.0'), false);
		});

		test('semver-range version pattern via flowR\'s real RRange', () => {
			assert.strictEqual(matchesVersion('>=3.0.0', '3.5.0'), true);
			assert.strictEqual(matchesVersion('>=3.0.0', '2.9.9'), false);
		});

		test('unparseable pattern matches nothing', () => {
			assert.strictEqual(matchesVersion('not a version', '3.5.0'), false);
		});
	});

	// exercises the real, on-disk search against a real (downloaded) base-R scope - not just the pure
	// pattern-matching helpers above - so a regression in the scope-scanning/glob-expansion logic itself
	// (not just the parsing/matching primitives) would actually be caught
	suite('findSigDbMatches (real base scope)', () => {
		let previousCacheDir: string | undefined;
		let tempDir: string;
		const output = vscode.window.createOutputChannel('vscode-flowr-test-sigdb-search');

		setup(() => {
			previousCacheDir = process.env.FLOWR_SIGDB_CACHE;
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-sigdb-search-test-'));
			process.env.FLOWR_SIGDB_CACHE = tempDir;
		});

		teardown(() => {
			if(previousCacheDir === undefined) {
				delete process.env.FLOWR_SIGDB_CACHE;
			} else {
				process.env.FLOWR_SIGDB_CACHE = previousCacheDir;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('finds an exact package, a glob package match, and an exact function within a real base scope', async function() {
			this.timeout(30000);
			if(!readSigDbRemotePointer()) {
				this.skip(); // no bundled release pointer in this build -- nothing to download
				return;
			}
			await downloadSigDbScope('base');

			const exact = await findSigDbMatches({ pkg: 'base' }, output, 'base');
			assert.strictEqual(exact.length, 1, 'expected exactly one match for the exact package name "base"');
			assert.strictEqual(exact[0].pkg, 'base');
			assert.strictEqual(exact[0].scope, 'base');

			// "stat*" matches both "stats" and "stats4" among the real base-R packages
			const glob = await findSigDbMatches({ pkg: 'stat*' }, output, 'base');
			assert.deepStrictEqual(glob.map(m => m.pkg).sort(), ['stats', 'stats4']);

			const fn = await findSigDbMatches({ pkg: 'base', fnName: 'print' }, output, 'base');
			assert.ok(fn.length > 0, 'expected "print" to be found in the real base package');
			assert.ok(fn.every(m => m.fnName === 'print' && m.pkg === 'base'));

			const noMatch = await findSigDbMatches({ pkg: 'this-package-does-not-exist' }, output, 'base');
			assert.deepStrictEqual(noMatch, []);
		});
	});
});
