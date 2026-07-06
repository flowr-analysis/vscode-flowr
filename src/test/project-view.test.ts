import assert from 'assert';
import { classifyLibrary, dedupeLibraries, parseDescription, parseRenvLock, parseRvLock, parseRvToml } from '../flowr/views/project-view';

suite('project view library matching', () => {
	// a stub standing in for the flowR package database: only `dplyr` is "known"
	const stubDb = {
		lookup: (name: string) => name === 'dplyr' ? { version: '1.1.4', exported: ['filter', 'mutate', 'select'] } : undefined
	} as unknown as Parameters<typeof classifyLibrary>[1];

	test('matches a package that the database knows', () => {
		const m = classifyLibrary('dplyr', stubDb);
		assert.equal(m.status, 'matched');
		assert.equal(m.dbVersion, '1.1.4');
		assert.equal(m.exportCount, 3);
	});

	test('reports base/recommended packages without consulting the database', () => {
		// `stats`/`MASS` are base/recommended packages - the throwing stub proves the database is not queried for them
		const throwingDb = {
			lookup: () => {
				throw new Error('should not be called for base packages');
			}
		} as unknown as Parameters<typeof classifyLibrary>[1];
		assert.equal(classifyLibrary('stats', throwingDb).status, 'base');
		assert.equal(classifyLibrary('MASS', throwingDb).status, 'base');
	});

	test('reports an unknown package as unmatched', () => {
		assert.equal(classifyLibrary('notARealPackage', stubDb).status, 'unmatched');
	});

	test('reports db-unavailable when there is no database', () => {
		assert.equal(classifyLibrary('dplyr', undefined).status, 'db-unavailable');
	});
});

suite('project view manifest parsing', () => {
	test('dedupeLibraries drops R, removes duplicates, and sorts', () => {
		const result = dedupeLibraries([
			{ name: 'purrr', declaredVersion: '1.0' },
			{ name: 'R', declaredVersion: '4.3' },
			{ name: 'dplyr' },
			{ name: 'purrr', declaredVersion: '9.9' },
			{ name: '' }
		]);
		assert.deepEqual(result.map(l => l.name), ['dplyr', 'purrr']);
		// the first occurrence's version wins
		assert.equal(result.find(l => l.name === 'purrr')?.declaredVersion, '1.0');
	});

	test('parses DESCRIPTION dependency fields', () => {
		const desc = [
			'Package: mypkg',
			'Version: 1.0',
			'Depends: R (>= 4.0.0), methods',
			'Imports:',
			'    dplyr (>= 1.0.0),',
			'    purrr,',
			'    rlang',
			'Suggests: testthat (>= 3.0.0)',
			'License: MIT'
		].join('\n');
		const libs = parseDescription(desc);
		const names = libs.map(l => l.name);
		assert.ok(names.includes('dplyr'), `expected dplyr, got ${names.join(', ')}`);
		assert.ok(names.includes('purrr'));
		assert.ok(names.includes('rlang'));
		assert.ok(names.includes('methods'));
		assert.ok(names.includes('testthat'));
		// R itself must not be reported as a library (it is the language, not a package) - but parsing keeps it;
		// the version constraint of dplyr should be captured
		const dplyr = libs.find(l => l.name === 'dplyr');
		assert.equal(dplyr?.declaredVersion, '>= 1.0.0');
	});

	test('parses renv.lock packages', () => {
		const lock = JSON.stringify({
			R:        { Version: '4.3.0' },
			Packages: {
				dplyr: { Package: 'dplyr', Version: '1.1.4', Source: 'Repository' },
				purrr: { Package: 'purrr', Version: '1.0.2', Source: 'Repository' }
			}
		});
		const libs = parseRenvLock(lock);
		assert.equal(libs.length, 2);
		const dplyr = libs.find(l => l.name === 'dplyr');
		assert.equal(dplyr?.declaredVersion, '1.1.4');
	});

	test('parses rv.lock package tables', () => {
		const lock = [
			'[[packages]]',
			'name = "dplyr"',
			'version = "1.1.4"',
			'',
			'[[packages]]',
			'name = "purrr"',
			'version = "1.0.2"'
		].join('\n');
		const libs = parseRvLock(lock);
		assert.deepEqual(libs.map(l => l.name).sort(), ['dplyr', 'purrr']);
	});

	test('parses rproject.toml dependency array', () => {
		const toml = [
			'name = "myproject"',
			'dependencies = [',
			'    "dplyr",',
			'    { name = "purrr", repository = "CRAN" },',
			']'
		].join('\n');
		const libs = parseRvToml(toml);
		assert.deepEqual(libs.map(l => l.name).sort(), ['dplyr', 'purrr']);
	});
});
