import assert from 'assert';
import { classifyLibrary, dedupeLibraries, parseDescription, parseDescriptionMeta, parseRenvLock, parseRvLock, parseRvToml } from '../flowr/views/project-view';

suite('project view library matching', () => {
	test('reports base packages as base', () => {
		assert.equal(classifyLibrary('stats').status, 'base');
		assert.equal(classifyLibrary('methods').status, 'base');
		assert.equal(classifyLibrary('base').status, 'base');
	});

	test('reports other packages as unmatched when sigdb is disabled', () => {
		assert.equal(classifyLibrary('dplyr').status, 'unmatched');
		assert.equal(classifyLibrary('MASS').status, 'unmatched');
		assert.equal(classifyLibrary('notARealPackage').status, 'unmatched');
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

	test('reads the package name and version a DESCRIPTION describes itself', () => {
		const desc = 'Package: ggplot2\nType: Package\nVersion: 3.5.1\nImports: rlang\n';
		const meta = parseDescriptionMeta(desc);
		assert.equal(meta.packageName, 'ggplot2');
		assert.equal(meta.packageVersion, '3.5.1');
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
