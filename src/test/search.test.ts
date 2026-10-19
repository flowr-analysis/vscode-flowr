import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import type { SearchEntry, SearchKind } from '../search';
import { filterEntries, filterOccurrences, matchScore, nameParts, parseQuery, parseRoles, SearchKinds } from '../search';

type Entry = { name: string, kind: string, summary: string, occurrences: { role: string, line: number, other?: string }[] };

suite('search', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	const index = async() => await vscode.commands.executeCommand<Entry[]>('vscode-flowr.internal.search.index');

	test('follows a variable through the dataflow graph', async() => {
		await openTestFile('search-example.R');
		const data = (await index()).find(e => e.name === 'data');
		assert.ok(data, 'data must be indexed');
		assert.strictEqual(data.kind, 'variable');
		const roles = data.occurrences.map(o => `${o.role}${o.other ? ` ${o.other}` : ''}@${o.line}`);
		assert.ok(roles.includes('definition@1'), roles.join());
		assert.ok(roles.includes('use@2'), roles.join());
		assert.ok(roles.includes('passed to filter()@2'), roles.join());
		assert.ok(roles.includes('flows into clean@2'), roles.join());
		assert.ok(data.summary.includes('flows into clean'), data.summary);
	});

	test('tells local functions, called functions and strings apart', async() => {
		await openTestFile('search-example.R');
		const entries = await index();
		const byName = (name: string) => entries.find(e => e.name === name);
		assert.strictEqual(byName('scale')?.kind, 'function');
		assert.deepStrictEqual(byName('scale')?.occurrences.map(o => `${o.role}@${o.line}`), ['definition@3', 'call@4']);
		assert.strictEqual(byName('read.csv')?.kind, 'call');
		const file = byName('measurements.csv');
		assert.strictEqual(file?.kind, 'string');
		assert.ok(file.summary.includes('given to read.csv()'), file.summary);
	});

	test('opens the search and restores the selection when it is closed', async() => {
		const editor = await openTestFile('search-example.R');
		const before = editor.selection;
		await vscode.commands.executeCommand('vscode-flowr.search');
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
		assert.ok(editor.selection.isEqual(before));
	});

	test('matches parts of names, best match first', () => {
		assert.deepStrictEqual(nameParts('my_data.frameName'), ['my', 'data', 'frame', 'name']);
		assert.ok((matchScore('measurements.csv', 'csv') ?? 0) > (matchScore('mycsvfile', 'csv') ?? 0), 'the start of a part beats the middle of a word');
		assert.strictEqual(matchScore('my_data', 'md'), 50, 'initials of the parts');
		assert.strictEqual(matchScore('clean', 'cln'), 10, 'letters in order');
		assert.strictEqual(matchScore('clean', 'xyz'), undefined);
		const entry = (name: string, kind: SearchKind): SearchEntry => ({ name, kind, occurrences: [] });
		const entries = [entry('data_clean', 'variable'), entry('clean', 'variable'), entry('cleanup', 'function'), entry('clean.csv', 'string')];
		const names = (value: string, kinds: readonly SearchKind[] = SearchKinds) => filterEntries(entries, value, new Set(kinds)).map(e => e.name);
		assert.deepStrictEqual(names('clean'), ['clean', 'cleanup', 'clean.csv', 'data_clean']);
		assert.deepStrictEqual(names('clean', ['variable']), ['clean', 'data_clean'], 'toggled off kinds are hidden');
		assert.deepStrictEqual(names('@s clean', ['variable']), ['clean.csv'], 'an @ filter overrides the toggles');
		assert.deepStrictEqual(parseQuery('@function @v foo @unknown'), { text: 'foo @unknown', kinds: new Set(['function', 'variable']) });
	});

	test('narrows the occurrences with @def, @use, @call and @flow', () => {
		const occurrences = [{ role: 'definition', code: 'x <- 1' }, { role: 'use', code: 'print(x)' }, { role: 'use', code: 'y <- x' }, { role: 'flows into', code: 'y <- x' }, { role: 'call', code: 'f(x)' }] as const;
		const codes = (value: string) => filterOccurrences(occurrences, value, o => o.code).map(o => `${o.role}:${o.code}`);
		assert.deepStrictEqual(codes('@use'), ['use:print(x)', 'use:y <- x']);
		assert.deepStrictEqual(codes('@use print'), ['use:print(x)']);
		assert.deepStrictEqual(codes('@def @flow'), ['definition:x <- 1', 'flows into:y <- x']);
		assert.deepStrictEqual(codes('@call'), ['call:f(x)']);
		assert.deepStrictEqual(codes('y <-'), ['use:y <- x', 'flows into:y <- x']);
		assert.deepStrictEqual(parseQuery('x @use'), { text: 'x', kinds: undefined }, 'role filters are no part of the name');
		assert.deepStrictEqual(parseRoles('@call x', false).roles, undefined, 'in the first step, @call means called functions');
	});

	test('is offered in the dependency view', () => {
		const menus = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { menus: Record<string, { command: string, when?: string }[]> } }).contributes.menus['view/title'];
		assert.ok(menus.some(m => m.command === 'vscode-flowr.search' && m.when === 'view == flowr-dependencies'));
	});

	test('is empty for non-R documents', async() => {
		await openTestFile('unrelated.ts');
		assert.deepStrictEqual(await index(), []);
	});
});
