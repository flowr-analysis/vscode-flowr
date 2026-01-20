import * as vscode from 'vscode';
import * as assert from 'assert';

import { activateExtension, openTestFile } from './test-util';
import type { Dependency } from '../flowr/views/dependency-view';

type DependencyDisplay = { label: string, description: string, children?: DependencyDisplay[] }

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
});
