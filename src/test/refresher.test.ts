import * as vscode from 'vscode';
import { Settings } from '../settings';
import { ConfigurableRefresher, type RefreshType } from '../configurable-refresher';
import assert from 'assert';

const Keys = {
	UpdateType: Settings.LinterUpdateType,
	Interval:   Settings.LinterUpdateInterval,
	BreakOff:   Settings.LinterAdaptiveBreak
} as const;

const TestFileName = 'refresher-test.r';

async function updateRefreshSettings(type: RefreshType, interval: number, breakOff: number) {
	const config = vscode.workspace.getConfiguration(Settings.Category);
	await config.update(Keys.UpdateType, type);
	await config.update(Keys.Interval, interval);
	await config.update(Keys.BreakOff, breakOff);
}

suite('refresher', () => {
	const backup = {
		UpdateType: '' as RefreshType,
		Interval:   0,
		BreakOff:   0
	};

	suiteSetup(() => {
		const config = vscode.workspace.getConfiguration(Settings.Category);
		backup.UpdateType = config.get(Keys.UpdateType, 'adaptive');
		backup.Interval   = config.get(Keys.Interval, 10);
		backup.BreakOff   = config.get(Keys.BreakOff, 5000);
	});

	suiteTeardown(async() => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder);
		const file = vscode.Uri.joinPath(folder.uri, TestFileName);
		await vscode.workspace.fs.delete(file);
		await updateRefreshSettings(backup.UpdateType, backup.Interval, backup.BreakOff);
	});

	const output: vscode.OutputChannel = vscode.window.createOutputChannel('TestChannel');

	function testRefresher(data: {name?: string, type: RefreshType, interval: number, breakOff: number, timeout: number, expectedTriggerCount: number, exactCount: boolean, action?: (editor: vscode.TextEditor) => Promise<void>}) {
		test(data.name ? `${data.name} (${data.type})` : data.type, async() => {
			await updateRefreshSettings(data.type, data.interval, data.breakOff);
		
			let triggerCount = 0;

			const folder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(folder);
			const file = vscode.Uri.joinPath(folder.uri, TestFileName);
			await vscode.workspace.fs.writeFile(file, Buffer.from('test <- 1'));
			const doc = await vscode.workspace.openTextDocument(file);
			const editor = await vscode.window.showTextDocument(doc);
            
			const refresher = new ConfigurableRefresher({
				name:                    'Test',
				configUpdateTypeKey:     Keys.UpdateType,
				configAdaptiveBreakKey:  Keys.BreakOff,
				configUpdateIntervalKey: Keys.Interval,
				refreshCallback:         () => {
					triggerCount++;
				},
				output: output
			});

			if(data.action) {
				await data.action(editor);
			}

			await new Promise(r => setTimeout(r, data.timeout));

			if(data.exactCount) {
				assert.equal(triggerCount, data.expectedTriggerCount);
			} else {
				assert(triggerCount >= data.expectedTriggerCount, `Expected to trigger ${data.expectedTriggerCount} or more, but triggered ${triggerCount} times`);
			}

			refresher.dispose();
		});
	}

	testRefresher({
		type:                 'on change', 
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
		type:                 'on change', 
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
		type:                 'on save',
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
		type:                 'on save',
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
		type:                 'interval',
		interval:             0.01,  
		breakOff:             0, 
		timeout:              100, 
		expectedTriggerCount: 5, 
		exactCount:           false
	});

	testRefresher({
		type:                 'never',
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