import * as vscode from 'vscode';
import { DependencyViewRefresherConfigKeys, LinterRefresherConfigKeys, Settings } from '../settings';
import type { RefresherConfigKeys } from '../configurable-refresher';
import { ConfigurableRefresher, RefreshType } from '../configurable-refresher';
import assert from 'assert';

const Keys = {
	updateType:    Settings.LinterUpdateType,
	interval:      Settings.LinterUpdateInterval,
	adaptiveBreak: Settings.LinterAdaptiveBreak
} satisfies RefresherConfigKeys;

const TestFileNameBase = 'refresher-test';

export async function updateRefreshSettings(keys: RefresherConfigKeys, type: RefreshType | undefined, interval: number | undefined, breakOff: number | undefined) {
	const config = vscode.workspace.getConfiguration(Settings.Category);
	await config.update(keys.updateType, type);
	await config.update(keys.interval, interval);
	await config.update(keys.adaptiveBreak, breakOff);
}

suite('refresher', () => {

	suiteTeardown(async() => {
		// remove keys from config
		await updateRefreshSettings(LinterRefresherConfigKeys, undefined, undefined, undefined);
		await updateRefreshSettings(DependencyViewRefresherConfigKeys, undefined, undefined, undefined);
	});

	const output: vscode.OutputChannel = vscode.window.createOutputChannel('TestChannel');

	function testRefresher(data: {name?: string, type: RefreshType, interval: number, breakOff: number, timeout: number, expectedTriggerCount: number, exactCount: boolean, action?: (editor: vscode.TextEditor) => Promise<void>}) {
		const testName = data.name ? `${data.name} (${data.type})` : data.type;
		const testFileName = data.name ? `${TestFileNameBase}-${data.name}-${data.type}.R` : `${TestFileNameBase}-${data.type}.R`;

		test(testName, async() => {
			await updateRefreshSettings(Keys, data.type, data.interval, data.breakOff);
		
			let triggerCount = 0;

			const folder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(folder);
			const file = vscode.Uri.joinPath(folder.uri, testFileName);
			await vscode.workspace.fs.writeFile(file, Buffer.from('test <- 1'));
			const doc = await vscode.workspace.openTextDocument(file);
			const editor = await vscode.window.showTextDocument(doc);
            
			const refresher = new ConfigurableRefresher({
				name:            'Test',
				keys:            Keys,
				refreshCallback: () => {
					triggerCount++;
				},
				output: output
			});

			if(data.action) {
				await data.action(editor);
			}

			await new Promise(r => setTimeout(r, data.timeout));

			await vscode.workspace.fs.delete(file);

			if(data.exactCount) {
				assert.equal(triggerCount, data.expectedTriggerCount);
			} else {
				assert(triggerCount >= data.expectedTriggerCount, `Expected to trigger ${data.expectedTriggerCount} or more, but triggered ${triggerCount} times`);
			}

			refresher.dispose();
		});
	}

	testRefresher({
		type:                 RefreshType.OnChange, 
		interval:             0, 
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 1, 
		exactCount:           true,
		action:               async(editor: vscode.TextEditor) => {
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
		} 
	}); 

	testRefresher({
		name:                 'multiple changes',
		type:                 RefreshType.OnChange, 
		interval:             0, 
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 3, 
		exactCount:           true,
		action:               async(editor: vscode.TextEditor) => {
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
		} 
	}); 

	testRefresher({
		type:                 RefreshType.OnSave,
		interval:             0,  
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 1, 
		exactCount:           true,
		action:               async(editor: vscode.TextEditor) => {
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.document.save();
		} 
	}); 

	testRefresher({
		name:                 'multiple changes',
		type:                 RefreshType.OnSave,
		interval:             0,  
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 2, 
		exactCount:           true,
		action:               async(editor: vscode.TextEditor) => {
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.document.save();

			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.document.save();
		} 
	}); 

	testRefresher({
		type:                 RefreshType.Interval,
		interval:             0.01,  
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 5, 
		exactCount:           false
	});

	testRefresher({
		type:                 RefreshType.Never,
		interval:             0.01,  
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 0, 
		exactCount:           true,
		action:               async(editor: vscode.TextEditor) => {
			await editor.edit((edit) => {
				edit.insert(new vscode.Position(0, 0), ' ');
			});
			await editor.document.save();
		} 
	});
});