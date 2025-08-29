import { getConfig, isVerbose } from './extension';
import { Settings } from './settings';
import * as vscode from 'vscode';

export interface ConfigurableRefresherConstructor {
    name:                 string;
	configUpdateTypeKey:     Settings;
	configAdaptiveBreakKey:  Settings;
	configUpdateIntervalKey: Settings;
	refreshCallback:         () => Promise<void>;
	configChangedCallback:   (() => void) | undefined;
	output:                  vscode.OutputChannel;
}

/**
 * Runs a callback based on a configurable refresh policy.
 * The callback can be called based on an interval
 */
export class ConfigurableRefresher {
	private readonly configUpdateTypeKey:       Settings;
	private readonly configAdaptiveBreakKey:    Settings;
	private readonly configUpdateIntervalKey:   Settings;	
	private readonly name:                      string;
	private readonly refreshCallback:           () => Promise<void>;
	private readonly configChangedCallback:     (() => void) | undefined;
	private activeInterval:                     NodeJS.Timeout | undefined;
	private activeDisposable:                   vscode.Disposable | undefined;
	private readonly didChangeConfigDisposable: vscode.Disposable;
	private readonly output:                    vscode.OutputChannel;

	constructor(c: ConfigurableRefresherConstructor) {
		// TODO: Just save the entire config as one object lul
		this.configUpdateTypeKey = c.configUpdateTypeKey;
		this.configAdaptiveBreakKey = c.configAdaptiveBreakKey;
		this.configUpdateIntervalKey = c.configUpdateIntervalKey;
		this.refreshCallback = c.refreshCallback;
		this.configChangedCallback = c.configChangedCallback;
		this.name = c.name;
		this.output = c.output;
        
		this.didChangeConfigDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
			await this.onDidChangeConfiguration(e);
		});

		this.update();
	}

	private async onDidChangeConfiguration(e: vscode.ConfigurationChangeEvent) {
		if(!e.affectsConfiguration(Settings.Category)) {
			return;
		}
	
		this.update();
		this.configChangedCallback?.();
		await this.refreshCallback();
	}

	private update() {
		this.output.append(`${this.name} Updating Configuration`);
	
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}
		switch(getConfig().get<string>(this.configUpdateTypeKey, 'never')) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => void this.refreshCallback(), getConfig().get<number>(this.configUpdateIntervalKey, 10) * 1000);
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(this.configAdaptiveBreakKey, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					this.activeInterval = setInterval(() => void this.refreshCallback(), getConfig().get<number>(this.configUpdateIntervalKey, 10) * 1000);
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							this.update();
						}
					});
				} else {
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(async e => {
						if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
							if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
								if(isVerbose()) {
									this.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
								}
								return;
							}
							await this.refreshCallback();
						}
						if(getActiveEditorCharLength() > breakOff) {
							this.update();
						}
					});
				}
				break;
			}
			case 'on save':
				this.activeDisposable = vscode.workspace.onWillSaveTextDocument(async() => await this.refreshCallback());
				break;
			case 'on change':
				this.activeDisposable = vscode.workspace.onDidChangeTextDocument(async e => {
					if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
						if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
							if(isVerbose()) {
								this.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
							}
							return;
						}
						await this.refreshCallback();
					}
				});
				break;
			default:
				this.output.appendLine(`[${this.name}] Invalid update type: ${getConfig().get<string>(this.configUpdateTypeKey)}`);
		}
	}

	public dispose() {
		clearInterval(this.activeInterval);
		this.activeDisposable?.dispose();
		this.didChangeConfigDisposable.dispose();
	}

	// TODO: toString() e.g. dependency-view z.25
}

function getActiveEditorCharLength() {
	return vscode.window.activeTextEditor?.document.getText().length ?? 0;
}