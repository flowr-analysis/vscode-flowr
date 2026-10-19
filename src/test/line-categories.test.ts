import * as vscode from 'vscode';
import assert from 'assert';
import { activateExtension, openTestFile } from './test-util';
import { CategoryColors, primaryCategory } from '../line-categories';
import { dependencyDisplayInfo } from '../flowr/views/dependency-view';

type Lines = { line: number, categories: string[], labels: string[] }[];
const Setting = 'style.lineCategoryIndicators';

suite('line category indicators', () => {
	suiteSetup(async() => {
		await activateExtension();
	});

	const get = async() => await vscode.commands.executeCommand<Lines>('vscode-flowr.internal.lineCategories');
	const cats = (lines: Lines, line: number) => lines.find(l => l.line === line)?.categories;

	test('classifies library, read, write and visualize lines', async() => {
		await openTestFile('line-categories-example.R');
		const lines = await get();
		assert.deepStrictEqual(cats(lines, 0), ['library']);
		assert.deepStrictEqual(cats(lines, 1), ['read']);
		assert.deepStrictEqual(cats(lines, 3), ['write']);
		assert.ok(cats(lines, 4)?.includes('visualize'), JSON.stringify(lines));
		assert.strictEqual(cats(lines, 2), undefined);
		assert.strictEqual(cats(lines, 5), undefined);
	});

	test('explains each indicator on hover, including namespace access', async() => {
		await openTestFile('line-categories-example.R');
		const label = (await get()).find(l => l.line === 0)?.labels.join();
		assert.ok(label?.includes('Libraries') && label.includes('`library`'), label);
		const doc = await vscode.workspace.openTextDocument({ language: 'r', content: 'x <- dplyr::select(df, a)\ny <- filter(x, a > 1)\n' });
		await vscode.window.showTextDocument(doc);
		const lines = await get();
		assert.deepStrictEqual(cats(lines, 0), ['library', 'transform'], JSON.stringify(lines));
		assert.ok(lines[0].labels.join().includes('`dplyr::…`'), lines[0].labels.join());
		assert.deepStrictEqual(cats(lines, 1), ['transform'], 'a plain filter() is no library dependency, but still a transformation');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});

	test('shows the furthest analysis step of a line and explains it on hover', async() => {
		const editor = await openTestFile('plots-example.R');
		const lines = await get();
		assert.deepStrictEqual(cats(lines, 3), ['transform'], JSON.stringify(lines));
		assert.deepStrictEqual(primaryCategory(['library', 'read', 'visualize']), 'visualize');
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(3, 2));
		const text = hovers.flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n');
		assert.ok(text.includes('Data Transformations') && text.includes('`dplyr::filter`'), text);
	});

	test('uses the same colors as the dependency view, in the order of the analysis', () => {
		const contributed = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { colors: { id: string, defaults: Record<string, string> }[] } }).contributes.colors;
		const fromTheme = Object.fromEntries(contributed.filter(c => c.id.startsWith('vscodeFlowr.category.')).map(c => {
			assert.ok(Object.values(c.defaults).every(v => v === c.defaults.dark), `${c.id} differs between themes`);
			return [c.id.slice('vscodeFlowr.category.'.length), c.defaults.dark];
		}));
		assert.deepStrictEqual(fromTheme, CategoryColors);
		assert.deepStrictEqual(Object.keys(CategoryColors), Object.keys(dependencyDisplayInfo));
	});

	test('marks R Markdown lines but not those of sourced scripts', async() => {
		await openTestFile('sourced-lint/main.Rmd');
		const lines = (await get()).map(({ line, categories }) => ({ line, categories }));
		assert.deepStrictEqual(lines, [{ line: 5, categories: ['source'] }, { line: 7, categories: ['write'] }], 'the library() of the sourced helper.R must not show up in main.Rmd');
	});

	test('is empty for non-R documents', async() => {
		await openTestFile('unrelated.ts');
		assert.deepStrictEqual(await get(), []);
	});

	test('can be disabled', async() => {
		const cfg = vscode.workspace.getConfiguration('vscode-flowr');
		const old = cfg.inspect<boolean>(Setting)?.workspaceValue;
		try {
			await openTestFile('line-categories-example.R');
			assert.ok((await get()).length > 0);
			await cfg.update(Setting, false, vscode.ConfigurationTarget.Workspace);
			assert.deepStrictEqual(await get(), []);
		} finally {
			await cfg.update(Setting, old, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('can be toggled from the dependency view', async() => {
		const cfg = vscode.workspace.getConfiguration('vscode-flowr');
		const old = cfg.inspect<boolean>(Setting)?.workspaceValue;
		try {
			await cfg.update(Setting, true, vscode.ConfigurationTarget.Workspace);
			await openTestFile('line-categories-example.R');
			await vscode.commands.executeCommand('vscode-flowr.style.toggleLineCategoryIndicators');
			assert.deepStrictEqual(await get(), []);
			await vscode.commands.executeCommand('vscode-flowr.style.toggleLineCategoryIndicators');
			assert.ok((await get()).length > 0);
			const menu = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as { contributes: { menus: Record<string, { command: string, when?: string }[]> } }).contributes.menus['view/title'];
			assert.ok(menu.some(m => m.command === 'vscode-flowr.style.toggleLineCategoryIndicators' && m.when === 'view == flowr-dependencies'));
		} finally {
			await cfg.update(Setting, old, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('respects enabled categories', async() => {
		const cfg = vscode.workspace.getConfiguration('vscode-flowr');
		const key = 'dependencyView.query.enabledCategories';
		const old = cfg.inspect<string[]>(key)?.workspaceValue;
		try {
			await openTestFile('line-categories-example.R');
			await cfg.update(key, ['library'], vscode.ConfigurationTarget.Workspace);
			const lines = await get();
			assert.deepStrictEqual(lines.map(l => l.categories), [['library']]);
		} finally {
			await cfg.update(key, old, vscode.ConfigurationTarget.Workspace);
		}
	});
});
