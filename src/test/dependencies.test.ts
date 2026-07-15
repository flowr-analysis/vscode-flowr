import * as vscode from 'vscode';
import * as assert from 'assert';import { activateExtension, openTestFile } from './test-util';
import type { Dependency } from '../flowr/views/dependency-view';

type DependencyDisplay = { label: string, description: string, children?: DependencyDisplay[] };

function simplifyDependencies(dependencies: Dependency[] | undefined): DependencyDisplay[] {
	return dependencies?.map(d => ({
		label:       typeof d.label === 'string' ? d.label : d.label?.label as string,
		description: d.description as string,
		children:    simplifyDependencies(d.children)
	})) ?? [];
}

function populateExpectedDependencies(expected: DependencyDisplay[]) {
	// set default values for any that we didn't specify
	for(const def of ['Libraries', 'Imported Data', 'Sourced Scripts', 'Outputs', 'Visualizations', 'Tests']) {
		if(expected.findIndex(e => e.label === def) < 0) {
			expected.push({ label: def, description: '0 items', children: [] });
		}
	}
	return expected;
}

async function verifyDependencies(expected: DependencyDisplay[]) {
	const result: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
	assert.ok(result);
	assert.deepEqual(simplifyDependencies(result), populateExpectedDependencies(expected));
}

suite('dependencies', () => {
	suiteSetup(async() => {
		await activateExtension();
		await vscode.commands.executeCommand('flowr-dependencies.focus');
	});

	test('vapply', async() => {
		await openTestFile('vapply-example.R');
		await verifyDependencies([
			{ label:       'Libraries', description: '6 items', children:    [
				{ label: 'a', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'b', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'c', description: 'by "library" in (L. 2)', children: [] },
				{ label: 'd', description: 'by "library" in (L. 5)', children: [] },
				{ label: 'e', description: 'by "library" in (L. 5)', children: [] },
				{ label: 'f', description: 'by "library" in (L. 5)', children: [] },
			] }
		]);
	});

	// typing a new `library()` line must be reflected in the view - the analyzer is keyed by document version,
	// so the edited (in-memory) text is re-analyzed rather than served stale from the cache
	test('reflects edits: a newly typed library() appears', async() => {
		const editor = await openTestFile('dep-edit-example.R');
		const libraryLabels = (deps: Dependency[] | undefined) =>
			simplifyDependencies(deps).find(d => d.label === 'Libraries')?.children?.map(c => c.label) ?? [];

		const before: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		assert.deepEqual(libraryLabels(before), ['alpha'], 'the fixture starts with a single library');

		// simulate the user typing a second library() call
		await editor.edit(eb => eb.insert(new vscode.Position(1, 0), 'library(beta)\n'));

		const after: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		assert.deepEqual(libraryLabels(after).sort(), ['alpha', 'beta'], 'the typed library must appear alongside the original');
	});

	// regression test: the "Go to Dependency" context-menu command used to only scroll the entry's location
	// into view without moving the cursor there, unlike clicking the entry directly (which does) - it must
	// actually navigate, the same way "go to definition"/"go to location" would
	test('"Go to Dependency" (context menu) moves the cursor to the entry\'s location', async() => {
		const editor = await openTestFile('vapply-example.R');
		editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		const result: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		const entry = result?.find(d => d.label === 'Libraries')?.children?.[0];
		assert.ok(entry, 'expected a library dependency entry');
		const loc = entry.getLocation();
		assert.ok(loc, 'expected the entry to know its source location');

		await vscode.commands.executeCommand('vscode-flowr.internal.goto.dependency', entry);
		// the command itself defers the actual move via setTimeout(…, 50)
		await new Promise(resolve => setTimeout(resolve, 200));

		assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, loc[0] - 1, 'expected the cursor to have moved to the dependency\'s line');
	});

	// regression test: a second refresh of unchanged content is served from the view's own cache, which must
	// still carry the location (used by "go to dependency") and ast/dfi (used when slicing from an entry) -
	// these were silently dropped on a cache hit before, breaking both features after the first refresh
	test('"go to dependency" and slicing still work on a cached (unchanged) refresh', async() => {
		await openTestFile('vapply-example.R');
		await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');

		const cached: Dependency[] | undefined = await vscode.commands.executeCommand('vscode-flowr.dependencyView.update');
		const entry = cached?.find(d => d.label === 'Libraries')?.children?.[0];
		assert.ok(entry, 'expected a library dependency entry on the cached refresh');
		assert.ok(entry.getLocation(), 'expected the cached entry to know its source location (used by "go to dependency")');
		assert.ok(entry.command, 'expected the cached entry to have a "go to location" command');
		assert.ok(entry.getAnalysisInfo(), 'expected the cached entry to still carry ast/dfi (used when slicing from a dependency entry)');
	});
});
