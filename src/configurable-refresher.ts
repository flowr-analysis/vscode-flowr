import { getConfig, isVerbose } from './extension';
import { Settings } from './settings';
import * as vscode from 'vscode';

type Callback<T> = (() => Promise<T>) | (() => T)

export interface ConfigurableRefresherConstructor {
    name:                   string;
	configUpdateTypeKey:       Settings;
	configAdaptiveBreakKey:    Settings;
	configUpdateIntervalKey:   Settings;
	refreshCallback:           Callback<void>;
    configChangedCallback?: Callback<void>;
	output:                    vscode.OutputChannel;
}

/**
 * Runs a callback based on a configurable refresh policy.
 * The callback can be called based on an interval
 */
export class ConfigurableRefresher {
	private activeInterval:   NodeJS.Timeout | undefined;
	private activeDisposable: vscode.Disposable | undefined;
	private disposables:      vscode.Disposable[] = [];
	private readonly spec:    ConfigurableRefresherConstructor;

	constructor(c: ConfigurableRefresherConstructor) {
		this.spec = c;
        
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if(!e.affectsConfiguration(Settings.Category)) {
				return;
			}
            
			this.runConfigChangedCallback();
			this.update();
			this.runRefreshCallback();
		}));

		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
			if(e?.document.languageId === 'r') {
				this.runRefreshCallback();
			}
		}));

		this.update();
	}

	private runRefreshCallback() {
		void this.spec.refreshCallback();
	}

	private runConfigChangedCallback() {
		void this.spec.configChangedCallback?.();
	}

	private update() {
		this.spec.output.append(`${this.spec.name} Updating Configuration`);
	
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}
		switch(getConfig().get<string>(this.spec.configUpdateTypeKey, 'never')) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.configUpdateIntervalKey, 10) * 1000);
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(this.spec.configAdaptiveBreakKey, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.configUpdateIntervalKey, 10) * 1000);
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							this.update();
						}
					});
				} else {
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
						if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
							if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
								if(isVerbose()) {
									this.spec.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
								}
								return;
							}
							this.runRefreshCallback();
						}
						if(getActiveEditorCharLength() > breakOff) {
							this.update();
						}
					});
				}
				break;
			}
			case 'on save':
				this.activeDisposable = vscode.workspace.onWillSaveTextDocument(() => this.runRefreshCallback());
				break;
			case 'on change':
				this.activeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
					if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
						if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
							if(isVerbose()) {
								this.spec.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
							}
							return;
						}
						this.runRefreshCallback();
					}
				});
				break;
			default:
				this.spec.output.appendLine(`[${this.spec.name}] Invalid update type: ${getConfig().get<string>(this.spec.configUpdateTypeKey)}`);
		}
	}

	public dispose() {
		clearInterval(this.activeInterval);
		this.activeDisposable?.dispose();

		for(const d of this.disposables) {
			d.dispose();
		}
	}
}

function getActiveEditorCharLength() {
	return vscode.window.activeTextEditor?.document.getText().length ?? 0;
}