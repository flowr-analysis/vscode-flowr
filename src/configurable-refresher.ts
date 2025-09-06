import type { AsyncOrSync } from 'ts-essentials';
import type { RefresherConfigKeys } from './settings';
import { Settings , getConfig, isVerbose } from './settings';
import * as vscode from 'vscode';


type Callback<T> = () => AsyncOrSync<T>;

export interface ConfigurableRefresherConstructor {
	name:                   string;
	keys:                   RefresherConfigKeys
	refreshCallback:        Callback<void>;
	configChangedCallback?: Callback<void>;
	output:                 vscode.OutputChannel;
}

export const enum RefreshType {
	Never = 'never', 
	Interval = 'interval',
	Adaptive = 'adaptive',
	OnSave = 'on save',
	OnChange = 'on change'
}

/**
 * Document Language ids that the refresher will trigger on
 */
const TriggerOnLanguageIds = ['r'];

/**
 * Runs a callback based on a configurable refresh policy.
 * The callback can be called based on an interval
 */
export class ConfigurableRefresher {
	private activeInterval:                   NodeJS.Timeout | undefined;
	private activeDisposable:                 vscode.Disposable | undefined;
	private disposables:                      vscode.Disposable[] = [];
	private readonly spec:                    ConfigurableRefresherConstructor;
	private static documentChangedDisposable: vscode.Disposable | undefined;
	private static onChangeRefreshers:        ConfigurableRefresher[] = [];

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
			if(isRTypeLanguage(e?.document)) {
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

	// If we have to run checks on every keystroke, we don't want to repeat the checks for all refreshers!
	private static onTextDocumentChanged(e: vscode.TextDocumentChangeEvent) {
		if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && isRTypeLanguage(vscode.window.activeTextEditor?.document)) {
			if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
				return;
			}

			for(const refresher of ConfigurableRefresher.onChangeRefreshers) {
				refresher.runRefreshCallback();
			}
		}
	}

	private static unregisterRefresherForOnChanged(refresher: ConfigurableRefresher) {
		const idx = this.onChangeRefreshers.indexOf(refresher);
		if(idx !== -1) {
			this.onChangeRefreshers.splice(idx, 1);
		}

		if(this.onChangeRefreshers.length === 0) {
			this.documentChangedDisposable?.dispose();
			this.documentChangedDisposable = undefined;
		}
	}

	private static registerRefresherForOnChanged(refresher: ConfigurableRefresher) {
		if(!ConfigurableRefresher.documentChangedDisposable) {
			ConfigurableRefresher.documentChangedDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
				ConfigurableRefresher.onTextDocumentChanged(e); 
			});
		}

		this.onChangeRefreshers.push(refresher);
	}

	private update() {
		this.spec.output.append(`[${this.spec.name}] Updating Configuration`);
	
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}

		ConfigurableRefresher.unregisterRefresherForOnChanged(this);

		switch(getConfig().get<RefreshType>(this.spec.keys.updateType, RefreshType.Never)) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.keys.interval, 10) * 1000);
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(this.spec.keys.adaptiveBreak, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.keys.interval, 10) * 1000);
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							this.update();
						}
					});
				} else {
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
						if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && isRTypeLanguage(vscode.window.activeTextEditor?.document)) {
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
				ConfigurableRefresher.registerRefresherForOnChanged(this);
				break;
			default:
				this.spec.output.appendLine(`[${this.spec.name}] Invalid update type: ${getConfig().get<string>(this.spec.keys.updateType)}`);
		}
	}

	public dispose() {
		ConfigurableRefresher.unregisterRefresherForOnChanged(this);
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

function isRTypeLanguage(doc?: vscode.TextDocument): boolean {
	if(!doc) {
		return false;
	}
	return TriggerOnLanguageIds.indexOf(doc.languageId) !== -1;
}